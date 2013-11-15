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


    var apiURL = "http://www.yr.no/place/";

    try {
    	var translations = JSON.parse(fs.readFileSync('translate.json'));
    	i18n.init({detectLngFromPath: true,resStore: translations, fallbackLng:'sv'});
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

// Show forecast data
app.get('/forecast/*', function(req, res) {
	return handleShowForecast(req, res);
});

var Helpers = {
	time: function(format,value){
		return strftime(format,new Date(Date.parse(value)));
	},
	temp: function(scale,value){
		var t;

		if(scale === "fahrenheit") t = ((value*9/5)+32).toFixed(2);
		else if(scale === "kelvin") t = (value + 273.15).toFixed(2);
		else if(scale === "rankine") t = ((value + 273.15)*9/5).toFixed(2);
		else t = value;

		return t;
	},
	length: function(scale,value){
		var l;

		if(scale === "inch") l = (value*1/25.4).toFixed(3);
		else l = value;

		return l;
	},
	speed: function(scale,value){
		var s;

		if(scale === 'fps') s = (value*3.280840).toFixed(2);
		if(scale === 'knot') s = (value*1.943844).toFixed(2);
		else s = value;

		return s;
	},
	limit: function(array,limit){
		if(!limit) return array;

		return array.slice(0,limit);
	}
};

// Generic handler of forecast that
// outputs HTML or widget
function handleShowForecast(req, res) {

    console.log("req.query", JSON.stringify(req.query));

	var place = req.params[0],
	limit = req.query.limit == undefined ? 10 : req.query.limit;

	if(!place) {
		return res.send(400, "Missing place to forecast xml. Example: ?place=Norway/Telemark/Sauherad/Gvarv");
	}

	Cache.getOrFetch(place, function(err, data, fromCache) {

		if(err) {
			return res.send(err);
		}

		res.setHeader("X-Polman-Cache-Hit", fromCache || false);

		res.format({
			"html":function(){
				res.render('forecast',{data:data,items:limit,x:Helpers});
			},
			"application/json":function(){
                if(req.query.setLang)
                    res.render('forecast',{data:data,items:limit,x:Helpers},function(err,ret){
                        if(ret) res.json(html2JSON(ret));
                    });
				else res.json(data);
			},
			"application/javascript":function(){
				res.jsonp(data);
			}
		});    

	});
}


function html2JSON(html){
    var data,
        thExp = /<th>([\w]+)<\/th>/g, attr,
        tdExp = /<td>([^<]*)<\/td>/g, values;

    attr = html.match(thExp).map(function(m){ 
        return m.replace(thExp,'$1') 
    });

    values = html.match(/<tbody>(.*)<\/tbody>/g)[0].split('<\/tr>').map(function(m){ return m.match(tdExp)}).filter(function(f){return !!f}).map(function(m){ return m.map(function(n){return n.replace(tdExp,'$1') }) }); 

    var data = {};
    
    for(var i in attr){
        data[attr[i]] = [];
        console.log("data attr", attr[i]);
      for(var x = 0; x < values.length; x++)
        if(values[x]) data[attr[i]].push(values[x][i]);   
    } 

    return data;
}


//
// YR client for fetching and parsing data from
// yr.no's web service.
//
YR = {

	initialize: function() {
		this.xml2js = new xml2js.Parser({ mergeAttrs: true, explicitArray: false });
	},

  // Fetch weather data from given url
  fetch: function(place, cb) {
  	var self = this;

  	http.get(apiURL+place+"/forecast.xml", function(res) {
  		var buf = '';

  		if(res.status > 399) {
  			cb.call(this, "Failed to retrieve data for " + place);
  		}

  		res.on('data', function (data) {
  			buf+= data;
  		});

  		res.on('end', function () {
        // Parse XML from yr.no into JSON format
        // that can be used when rendering the view.
        self.xml2js.parseString(buf, function(err, json) {

        	if(err || json['error']) {
        		cb.call(this, "Error: Failed to parse XML from yr.no");
        		return;
        	}

        	var data = {
        		forecast: json.weatherdata.forecast.tabular.time,
        		location: json.weatherdata.location,
        		credit: json.weatherdata.credit,
        		meta: json.weatherdata.meta,
        		sun: json.weatherdata.sun
        	};

        	Cache.set(place, data);

        	cb.call(this, undefined, data);
        });
    });

  		res.on('error', function () {
  			cb.call(this, "Failed to fetch data from yr.no");
  		});
  	}).end();

}

};

Cache = {
	store:{},
	ttl: 60*15*1000,
	getOrFetch: function(key, cb) {
		var data = this.get(key);

		if(data) {
        // Hit from cache
        cb.call(this, undefined, data, true);
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

