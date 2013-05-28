var express = require('express'),
    //routes = require('./routes'),
    http = require('http'),
    path = require('path'),
    xml2js = require('xml2js'),
    strftime = require('strftime'),
    i18n = require('i18next'),
    fs = require('fs'),
    Cache,
    YR;



try {
  var translations = JSON.parse(fs.readFileSync('translate.json'));
  i18n.init({resStore: translations, fallbackLng:'en'});
} catch(error){
  console.error("Failed to open or parse translations:",error);
  process.exit(1);
}


var app = express();


app.configure(function(){
  app.set('port', process.env.PORT || 3000);
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.set('jsonp callback name','jsonp');  
  app.use(express.favicon());
  app.use(express.logger('dev'));
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(i18n.handle);
  app.use(app.router);
  app.use(require('less-middleware')({ src: __dirname + '/public' }));
  app.use(express.static(path.join(__dirname, 'public')));
});

app.configure('development', function(){
  app.use(express.errorHandler());
});

i18n.registerAppHelper(app);


//
// Routes and handlers
//
// Home page
app.get('/', function(req, res){
  res.render('index');
});

// Create widget
app.post('/', function(req, res){
  var url = req.body.url,
      num = req.body.num || 10,
      lang = req.body.lang || 'en';

  if(!url) {
    return res.render('index', {error: "Please enter a valid URL. Example:<br/>http://www.yr.no/place/Sweden/Stockholm/Stockholm/"});
  }

  url = tidyUrl(url);
  res.render('created', {url: url, num: num, lang: lang});
});

// Show forecast data
app.get('/api/forecast', function(req, res) {
    return handleShowForecast(req, res);
});

var Helpers = {
  time: function(format,value){
    return strftime(format,new Date(Date.parse(value)));
  },
  temp: function(scale,value){
    var t;

    if(scale === "fahrenheit") t = ((value*9/5)+32).toFixed(2) + "&deg;F";
    else if(scale === "kelvin") t = (value + 273.15).toFixed(2) + "&deg;K";
    else if(scale === "rankine") t = ((value + 273.15)*9/5).toFixed(2) + "&deg;R";
    else t = value + "&deg;C";
    
    return t;
  },
  length: function(scale,value){
    var l;
    
    if(scale === "inch") l = (value*1/25.4).toFixed(3) + "\"";
    else l = value + "mm";

    return l;
  },
  speed: function(scale,value){
    var s;

    if(scale === 'fps') s = (value*3.280840).toFixed(2) + 'ft/s';
    if(scale === 'knot') s = (value*1.943844).toFixed(2) + 'knots';
    else s = value + 'm/s';
    
    return s;
  }
};

// Generic handler of forecast that
// outputs HTML or widget
function handleShowForecast(req, res) {
  var weatherUrl = req.query.url,
      limit = req.query.limit || 10;

  if(!weatherUrl) {
    return res.send(400, "Missing url to forecast xml. Example: ?url=http://www.yr.no/place/Norway/Telemark/Sauherad/Gvarv/forecast.xml");
  }

  weatherUrl = weatherUrl.replace('http://', '');

  Cache.getOrFetch(weatherUrl, function(err, forecast, fromCache) {

    if(err) {
      return res.send(err);
    }

    res.setHeader("X-Polman-Cache-Hit", fromCache || false);

    var data = {
      location: forecast.weatherdata.location,
      credit: forecast.weatherdata.credit,
      meta: forecast.weatherdata.meta,
      sun: forecast.weatherdata.sun,
      forecast: forecast.weatherdata.forecast.tabular
    };

    if(limit) data.forecast = data.forecast.slice(0,limit);

    res.format({
      "html":function(){
        res.render('forecast',{data:data,x:Helpers})
      },
      "application/json":function(){
        res.json(data);
      },
      "application/javascript":function(){
        res.jsonp(data);
      }
    });    
    
  });
}

// Tidies URL that user posted.
function tidyUrl(url) {
  if(url.slice(0,7).toLowerCase() !== 'http://') {
    url = 'http://' + url;
  }

  if(url.indexOf('.xml') === -1) {
    if(url.indexOf('/', url.length - 1) === -1) {
      url += '/';
    }
    url += 'forecast.xml';
  }
  return url;
}


//
// YR client for fetching and parsing data from
// yr.no's web service.
//
YR = {

  initialize: function() {
    this.parser = new xml2js.Parser({ mergeAttrs: true, explicitArray: false });
  },

  // Fetch weather data from given url
  fetch: function(url, cb) {
    var that = this;

    http.get({
      host: 'www.yr.no',
      path: url.slice(url.indexOf('/'), url.length)
    }, onResponse).end();

    function onResponse(res) {
      var body = '';

      if(res.status >= 400) {
        cb.call(this, "Could not retriev data from " + url + " - are you sure this is a valid URL?");
      }

      res.on('data', function (chunk) {
        body += chunk;
      });
    
      res.on('end', function () {
        that.xmlToJson(body, function(err, json) {
          if(err || json['error']) {
            cb.call(this, "Error: Could not parse XML from yr.no");
            return;
          }
          json = that.tidyJSON(json);
          Cache.set(url, json);
          cb.call(this, undefined, json);
        });
      });

      res.on('error', function () {
        cb.call(this, "Could not fetch data from yr.no");
      });
    }
  },

  // Parse XML from yr.no into JSON format
  // that can be used when rendering the view.
  xmlToJson: function(xml, cb) {
    this.parser.parseString(xml, cb);
  },

  // Tidy JSON object that was automagically
  // created from XML
  tidyJSON: function(json) {
    json.weatherdata.forecast.tabular = json.weatherdata.forecast.tabular.time;
    if(json.weatherdata.forecast.text) {
      delete json.weatherdata.forecast.text;
    }
    return json;
  }

};

Cache = {
  store:{},
  ttl: 60*15*1000,
  getOrFetch: function(key, cb) {
    var forecast = this.get(key);
    
    if(forecast) {
        // Hit from cache
        cb.call(this, undefined, forecast, true);
    } else {
        // Go ask yr.no about the forecast
        YR.fetch(key, cb);
    }
  },
  get: function(key) {
    var cached = this.store[key];
    
    if(cached && Date.now() < cached.expiry) 
      return cached.data;
  },
  set: function(key, value, ttl) {
    ttl = ttl ? ttl : this.ttl;
    this.store[key] = {data:value, expiry:Date.now()+ttl};
  }


};


//
// Create and start server :)
//
http.createServer(app).listen(app.get('port'), function(){
  console.log("Express server listening on port " + app.get('port'));
  YR.initialize();
});

