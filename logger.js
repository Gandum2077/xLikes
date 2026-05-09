"use strict";

var fs = require("fs");
var path = require("path");

var state = {
  enabled: false,
  rootDir: "",
  logDir: "",
  logFile: "",
  startedAt: "",
  maxStringLength: 6000,
  maxArrayItems: 30,
  maxDepth: 6,
  counter: 0
};

function loadEnv(rootDir) {
  var envPath = path.join(rootDir, ".env");
  var parsed = {};
  if (!fs.existsSync(envPath)) {
    return parsed;
  }
  var content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    var eqIndex;
    var key;
    var value;
    if (!trimmed || trimmed.charAt(0) === "#") {
      return;
    }
    eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      return;
    }
    key = trimmed.slice(0, eqIndex).trim();
    value = trimmed.slice(eqIndex + 1).trim();
    if ((value.charAt(0) === "\"" && value.charAt(value.length - 1) === "\"") ||
        (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }
    if (key) {
      parsed[key] = value;
      if (typeof process.env[key] === "undefined") {
        process.env[key] = value;
      }
    }
  });
  return parsed;
}

function envPath() {
  return path.join(state.rootDir || process.cwd(), ".env");
}

function envLineValue(value) {
  value = String(value || "");
  if (value.indexOf("\n") !== -1 || value.indexOf("\r") !== -1) {
    value = value.replace(/[\r\n]+/g, "");
  }
  return value;
}

function setEnvValues(values) {
  var filePath = envPath();
  var content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  var lines = content ? content.split(/\r?\n/) : [];
  var seen = {};
  var keys = Object.keys(values || {});
  var output;

  output = lines.map(function (line) {
    var trimmed = line.trim();
    var eqIndex = trimmed.indexOf("=");
    var key;
    if (!trimmed || trimmed.charAt(0) === "#" || eqIndex === -1) {
      return line;
    }
    key = trimmed.slice(0, eqIndex).trim();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      seen[key] = true;
      process.env[key] = envLineValue(values[key]);
      return key + "=" + envLineValue(values[key]);
    }
    return line;
  });

  keys.forEach(function (key) {
    if (!seen[key]) {
      process.env[key] = envLineValue(values[key]);
      output.push(key + "=" + envLineValue(values[key]));
    }
  });

  while (output.length && output[output.length - 1] === "") {
    output.pop();
  }
  fs.writeFileSync(filePath, output.join("\n") + "\n", "utf8");
  info("env.update", {
    keys: keys
  });
}

function boolValue(value) {
  var normalized = String(value || "").toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
}

function safeStartupName(iso) {
  return iso.replace(/[:.]/g, "-") + ".log";
}

function init(rootDir) {
  var startedAt = new Date().toISOString();
  var env = loadEnv(rootDir);
  var logDirName = process.env.LOG_DIR || "logs";
  state.rootDir = rootDir;
  state.startedAt = startedAt;
  state.enabled = boolValue(process.env.LOG_ENABLED);
  state.maxStringLength = parseInt(process.env.LOG_MAX_FIELD_LENGTH || "6000", 10) || 6000;
  state.maxArrayItems = parseInt(process.env.LOG_MAX_ARRAY_ITEMS || "30", 10) || 30;
  state.maxDepth = parseInt(process.env.LOG_MAX_DEPTH || "6", 10) || 6;
  state.logDir = path.isAbsolute(logDirName) ? logDirName : path.join(rootDir, logDirName);
  state.logFile = path.join(state.logDir, safeStartupName(startedAt));
  if (state.enabled) {
    ensureDir(state.logDir);
    fs.writeFileSync(state.logFile, "", "utf8");
    info("logger.start", {
      enabled: true,
      logFile: state.logFile,
      startedAt: state.startedAt,
      envKeys: Object.keys(env)
    });
  }
  return state;
}

function isEnabled() {
  return !!state.enabled;
}

function nextId(prefix) {
  state.counter += 1;
  return String(prefix || "log") + "-" + state.counter;
}

function isSensitiveKey(key) {
  var normalized = String(key || "").toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "clientsecret" ||
    normalized === "bearer" ||
    normalized === "token" ||
    normalized.indexOf("bearer") !== -1 ||
    normalized.indexOf("token") !== -1 ||
    normalized.indexOf("password") !== -1 ||
    normalized.indexOf("secret") !== -1;
}

function truncateString(value) {
  if (value.length <= state.maxStringLength) {
    return value;
  }
  return value.slice(0, state.maxStringLength) + "...[truncated " + (value.length - state.maxStringLength) + " chars]";
}

function sanitize(value, depth, seen) {
  var type = typeof value;
  var out;
  var keys;
  var i;
  var key;
  if (value === null || typeof value === "undefined") {
    return value;
  }
  if (type === "string") {
    return truncateString(value);
  }
  if (type === "number" || type === "boolean") {
    return value;
  }
  if (value instanceof Error) {
    return errorToObject(value);
  }
  if (Buffer.isBuffer(value)) {
    return "[Buffer " + value.length + " bytes]";
  }
  if (depth >= state.maxDepth) {
    return "[MaxDepth]";
  }
  seen = seen || [];
  if (seen.indexOf(value) !== -1) {
    return "[Circular]";
  }
  seen.push(value);
  if (Object.prototype.toString.call(value) === "[object Array]") {
    out = [];
    for (i = 0; i < value.length && i < state.maxArrayItems; i += 1) {
      out.push(sanitize(value[i], depth + 1, seen));
    }
    if (value.length > state.maxArrayItems) {
      out.push({
        truncated: true,
        remainingItems: value.length - state.maxArrayItems
      });
    }
    seen.pop();
    return out;
  }
  out = {};
  keys = Object.keys(value);
  for (i = 0; i < keys.length; i += 1) {
    key = keys[i];
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitize(value[key], depth + 1, seen);
    }
  }
  seen.pop();
  return out;
}

function errorToObject(err) {
  if (!err) {
    return null;
  }
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    statusCode: err.statusCode || err.status || null,
    code: err.code || null,
    stack: err.stack || null,
    detail: sanitize(err.detail || null, 0, [])
  };
}

function write(level, event, data) {
  var entry;
  var line;
  if (!state.enabled) {
    return;
  }
  entry = {
    ts: new Date().toISOString(),
    level: level,
    event: event,
    data: sanitize(data || {}, 0, [])
  };
  try {
    line = JSON.stringify(entry);
  } catch (err) {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "logger.stringify_failed",
      data: {
        event: event,
        error: err.message
      }
    });
  }
  console.log(line);
  fs.appendFileSync(state.logFile, line + "\n", "utf8");
}

function info(event, data) {
  write("info", event, data);
}

function warn(event, data) {
  write("warn", event, data);
}

function error(event, data) {
  write("error", event, data);
}

function requestSummary(req) {
  return {
    id: req._logRequestId || "",
    method: req.method,
    url: req.originalUrl || req.url,
    query: req.query || {},
    body: req.body || {},
    ip: req.ip || "",
    userAgent: req.headers ? req.headers["user-agent"] || "" : ""
  };
}

function apiMiddleware() {
  return function (req, res, next) {
    var started = Date.now();
    var oldJson;
    var oldSend;
    if (!state.enabled) {
      next();
      return;
    }
    req._logRequestId = nextId("api");
    info("api.request", {
      request: requestSummary(req)
    });
    oldJson = res.json;
    oldSend = res.send;
    res.json = function (body) {
      res._logResponseBody = body;
      return oldJson.call(this, body);
    };
    res.send = function (body) {
      if (typeof res._logResponseBody === "undefined") {
        res._logResponseBody = body;
      }
      return oldSend.call(this, body);
    };
    res.on("finish", function () {
      info("api.response", {
        durationMs: Date.now() - started,
        request: requestSummary(req),
        response: {
          statusCode: res.statusCode,
          body: res._logResponseBody
        }
      });
    });
    next();
  };
}

function getState() {
  return {
    enabled: state.enabled,
    logFile: state.logFile,
    startedAt: state.startedAt
  };
}

module.exports = {
  init: init,
  loadEnv: loadEnv,
  setEnvValues: setEnvValues,
  isEnabled: isEnabled,
  nextId: nextId,
  info: info,
  warn: warn,
  error: error,
  errorToObject: errorToObject,
  requestSummary: requestSummary,
  apiMiddleware: apiMiddleware,
  getState: getState,
  sanitize: function (value) {
    return sanitize(value, 0, []);
  }
};
