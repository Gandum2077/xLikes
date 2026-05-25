"use strict";

var fs = require("fs");
var path = require("path");
var express = require("express");
var low = require("lowdb");
var FileSync = require("lowdb/adapters/FileSync");
var logger = require("./logger");
var apiRoutes = require("./routes/api");

var ROOT_DIR = process.cwd();
logger.init(ROOT_DIR);

var HOST = process.env.HOST || "127.0.0.1";
var PORT = process.env.PORT || 3000;
var PUBLIC_DIR = path.join(ROOT_DIR, "public");
var MEDIA_DIR = path.join(PUBLIC_DIR, "media");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

ensureDir(PUBLIC_DIR);
ensureDir(MEDIA_DIR);

var adapter = new FileSync(path.join(ROOT_DIR, "db.json"));
var db = low(adapter);

// Lowdb defaults also work as a lightweight migration for older local data.
db.defaults({
  settings: {
    lastTokenRefreshAt: "",
    lastTokenRefreshError: "",
    userId: "",
    username: "",
    name: "",
    profileImageUrl: "",
    autoSyncOnStart: false,
    tagSort: "count",
    searchHistory: [],
    lastAccountCheck: null,
    createdAt: new Date().toISOString()
  },
  tweets: [],
  sync: {
    lastMode: "",
    lastStartedAt: "",
    lastFinishedAt: "",
    lastError: "",
    lastRateLimit: null,
    lastSummary: null
  }
}).write();

var app = express();

app.locals.db = db;
app.locals.rootDir = ROOT_DIR;
app.locals.publicDir = PUBLIC_DIR;
app.locals.mediaDir = MEDIA_DIR;
app.locals.logger = logger;

app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: true }));

// The app is local-first; disable response caching so settings and sync state stay fresh.
app.use(function (req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Serve the browser Axios build from the installed dependency, with a small fallback
// for constrained JSBox installs that only expose Node-side modules.
app.get("/vendor/axios.min.js", function (req, res) {
  try {
    res.sendFile(require.resolve("axios/dist/axios.min.js"));
  } catch (err) {
    res.type("application/javascript");
    res.send("(function(){function r(m,u,d){return new Promise(function(ok,fail){var x=new XMLHttpRequest();x.open(m,u,true);x.setRequestHeader('Content-Type','application/json');x.onreadystatechange=function(){if(x.readyState===4){var body=x.responseText;try{body=JSON.parse(body);}catch(e){}var res={data:body,status:x.status,headers:{}};if(x.status>=200&&x.status<300){ok(res);}else{var er=new Error(body&&body.error?body.error:'Request failed');er.response=res;fail(er);}}};x.onerror=function(){fail(new Error('Network error'));};x.send(d?JSON.stringify(d):null);});}window.axios={get:function(u,c){var q='';if(c&&c.params){var a=[];Object.keys(c.params).forEach(function(k){if(c.params[k]!==undefined&&c.params[k]!==null&&c.params[k]!==''){a.push(encodeURIComponent(k)+'='+encodeURIComponent(c.params[k]));}});q=a.length?(u.indexOf('?')===-1?'?':'&')+a.join('&'):'';}return r('GET',u+q);},post:function(u,d){return r('POST',u,d);},put:function(u,d){return r('PUT',u,d);},delete:function(u){return r('DELETE',u);}};}());");
  }
});

app.use(express.static(PUBLIC_DIR));
app.use("/api", logger.apiMiddleware());
app.use("/api", apiRoutes);

app.use(function (req, res) {
  res.status(404).json({
    ok: false,
    error: "Not found"
  });
});

// Centralized API error handling keeps route code compact and gives the UI
// consistent error messages.
app.use(function (err, req, res, next) {
  var status = err.statusCode || err.status || 500;
  var message = err.publicMessage || err.message || "Server error";
  logger.error("api.error", {
    request: logger.requestSummary(req),
    error: logger.errorToObject(err)
  });
  res.status(status).json({
    ok: false,
    error: message,
    detail: err.detail || null
  });
});

app.listen(PORT, HOST, () => {
  logger.info("app.listen", {
    host: HOST,
    port: PORT,
    url: "http://" + HOST + ":" + PORT,
    log: logger.getState()
  });
  if (typeof $jsbox !== "undefined") {
    $jsbox.run(`
      $ui.render({
        props: {
          navBarHidden: true,
          statusBarStyle: 0,
          theme: "auto",
        },
        views: [
          {
            type: "web",
            props: {
              url: "${"http://" + HOST + ":" + PORT}"
            },
            layout: $layout.fill
          }
        ]
      });`);
  } else {
    console.log("Running at http://" + HOST + ":" + PORT);
  }
});
