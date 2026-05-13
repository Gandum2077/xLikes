"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var querystring = require("querystring");
var axios = require("axios");
var express = require("express");
var logger = require("../logger");

var router = express.Router();
var X_API_BASE = "https://api.x.com";
var LONG_VIDEO_MS = 30000;
var LIKED_TWEETS_INCREMENTAL_MAX_RESULTS = 5;
var LIKED_TWEETS_FULL_MAX_RESULTS = 100;
var LIKED_TWEETS_AUTH_TEST_MAX_RESULTS = 5;
var mediaDownloadJobs = {};
var CREDENTIAL_ENV_KEYS = {
  accessToken: "X_ACCESS_TOKEN",
  refreshToken: "X_REFRESH_TOKEN",
  clientId: "X_CLIENT_ID",
  clientSecret: "X_CLIENT_SECRET",
  tokenExpiresAt: "X_TOKEN_EXPIRES_AT"
};

function nowIso() {
  return new Date().toISOString();
}

function getDb(req) {
  return req.app.locals.db;
}

function getSettings(db) {
  var settings = db.get("settings").value() || {};
  if (!settings.searchHistory) {
    settings.searchHistory = [];
  }
  if (!settings.tagSort) {
    settings.tagSort = "count";
  }
  settings.accessToken = process.env.X_ACCESS_TOKEN || "";
  settings.refreshToken = process.env.X_REFRESH_TOKEN || "";
  settings.clientId = process.env.X_CLIENT_ID || "";
  settings.clientSecret = process.env.X_CLIENT_SECRET || "";
  settings.tokenExpiresAt = process.env.X_TOKEN_EXPIRES_AT || "";
  return settings;
}

function settingsForDb(settings) {
  var cleaned = Object.assign({}, settings || {});
  delete cleaned.accessToken;
  delete cleaned.refreshToken;
  delete cleaned.clientId;
  delete cleaned.clientSecret;
  delete cleaned.tokenExpiresAt;
  return cleaned;
}

function writeSettings(db, settings) {
  db.set("settings", settingsForDb(settings)).write();
}

function credentialEnvUpdateFromBody(body) {
  var updates = {};
  if (typeof body.accessToken === "string" && body.accessToken.trim()) {
    updates[CREDENTIAL_ENV_KEYS.accessToken] = body.accessToken.trim();
  }
  if (typeof body.refreshToken === "string" && body.refreshToken.trim()) {
    updates[CREDENTIAL_ENV_KEYS.refreshToken] = body.refreshToken.trim();
  }
  if (typeof body.clientId === "string" && body.clientId.trim()) {
    updates[CREDENTIAL_ENV_KEYS.clientId] = body.clientId.trim();
  }
  if (typeof body.clientSecret === "string" && body.clientSecret.trim()) {
    updates[CREDENTIAL_ENV_KEYS.clientSecret] = body.clientSecret.trim();
  }
  return updates;
}

function applyCredentialEnvUpdate(settings, updates) {
  if (Object.prototype.hasOwnProperty.call(updates, CREDENTIAL_ENV_KEYS.accessToken)) {
    settings.accessToken = updates[CREDENTIAL_ENV_KEYS.accessToken];
  }
  if (Object.prototype.hasOwnProperty.call(updates, CREDENTIAL_ENV_KEYS.refreshToken)) {
    settings.refreshToken = updates[CREDENTIAL_ENV_KEYS.refreshToken];
  }
  if (Object.prototype.hasOwnProperty.call(updates, CREDENTIAL_ENV_KEYS.clientId)) {
    settings.clientId = updates[CREDENTIAL_ENV_KEYS.clientId];
  }
  if (Object.prototype.hasOwnProperty.call(updates, CREDENTIAL_ENV_KEYS.clientSecret)) {
    settings.clientSecret = updates[CREDENTIAL_ENV_KEYS.clientSecret];
  }
  if (Object.prototype.hasOwnProperty.call(updates, CREDENTIAL_ENV_KEYS.tokenExpiresAt)) {
    settings.tokenExpiresAt = updates[CREDENTIAL_ENV_KEYS.tokenExpiresAt];
  }
}

function publicSettings(settings) {
  var token = settings.accessToken || "";
  var refreshToken = settings.refreshToken || "";
  return {
    hasAccessToken: !!token,
    tokenPreview: token ? token.slice(0, 8) + "..." + token.slice(-4) : "",
    hasRefreshToken: !!refreshToken,
    refreshTokenPreview: refreshToken ? refreshToken.slice(0, 8) + "..." + refreshToken.slice(-4) : "",
    clientId: settings.clientId || "",
    hasClientSecret: !!settings.clientSecret,
    tokenExpiresAt: settings.tokenExpiresAt || "",
    lastTokenRefreshAt: settings.lastTokenRefreshAt || "",
    lastTokenRefreshError: settings.lastTokenRefreshError || "",
    userId: settings.userId || "",
    username: settings.username || "",
    name: settings.name || "",
    profileImageUrl: settings.profileImageUrl || "",
    autoSyncOnStart: !!settings.autoSyncOnStart,
    tagSort: settings.tagSort || "count",
    searchHistory: settings.searchHistory || [],
    lastAccountCheck: settings.lastAccountCheck || null
  };
}

function requireConfigured(settings) {
  if (!settings.accessToken) {
    var err = new Error("请先填写 OAuth 2.0 用户上下文 Access Token。");
    err.statusCode = 400;
    throw err;
  }
}

function requireUserId(settings) {
  if (!settings.userId) {
    var err = new Error("尚未识别授权用户。请先保存并测试 Token，应用会通过 /2/users/me 自动获取用户 ID。");
    err.statusCode = 400;
    throw err;
  }
}

function bearerValue(settings) {
  var token = (settings.accessToken || "").trim();
  if (token.indexOf("Bearer ") === 0) {
    return token;
  }
  return "Bearer " + token;
}

function headersForLog(headers) {
  headers = headers || {};
  return {
    contentType: headers["content-type"] || "",
    contentLength: headers["content-length"] || "",
    rateLimitLimit: headers["x-rate-limit-limit"] || "",
    rateLimitRemaining: headers["x-rate-limit-remaining"] || "",
    rateLimitReset: headers["x-rate-limit-reset"] || ""
  };
}

function xRequest(settings, method, pathname, params, responseType, db, retryingAfterRefresh) {
  var requestId = logger.nextId("xapi");
  var startedAt = Date.now();
  var requestUrl = X_API_BASE + pathname;
  requireConfigured(settings);
  logger.info("xapi.request", {
    id: requestId,
    method: method,
    url: requestUrl,
    params: params || {},
    responseType: responseType || "json",
    retryingAfterRefresh: !!retryingAfterRefresh
  });
  return axios({
    method: method,
    url: requestUrl,
    params: params || {},
    headers: {
      Authorization: bearerValue(settings),
      "User-Agent": "xLikes/1.0"
    },
    timeout: 45000,
    responseType: responseType || "json",
    validateStatus: function (status) {
      return status >= 200 && status < 300;
    }
  }).then(function (response) {
    logger.info("xapi.response", {
      id: requestId,
      durationMs: Date.now() - startedAt,
      status: response.status,
      headers: headersForLog(response.headers),
      data: responseType === "stream" ? "[stream]" : response.data
    });
    return response;
  }).catch(function (error) {
    var willAttemptRefresh = !retryingAfterRefresh && shouldAttemptTokenRefresh(error) && canRefreshToken(settings);
    logger.error("xapi.error", {
      id: requestId,
      durationMs: Date.now() - startedAt,
      method: method,
      url: requestUrl,
      params: params || {},
      status: error.response && error.response.status ? error.response.status : null,
      headers: error.response && error.response.headers ? headersForLog(error.response.headers) : null,
      data: error.response && error.response.data ? error.response.data : null,
      message: error.message,
      willAttemptRefresh: willAttemptRefresh
    });
    if (willAttemptRefresh) {
      return refreshAccessToken(settings, db).then(function () {
        return xRequest(settings, method, pathname, params, responseType, db, true);
      }).catch(function (refreshError) {
        var wrappedRefresh = new Error("Access Token 可能已过期，自动刷新失败：" + (refreshError.message || "请重新授权。"));
        wrappedRefresh.statusCode = refreshError.statusCode || 401;
        wrappedRefresh.detail = refreshError.detail || null;
        throw wrappedRefresh;
      });
    }
    var wrapped = new Error(readXError(error));
    wrapped.statusCode = error.response && error.response.status ? error.response.status : 502;
    wrapped.detail = error.response && error.response.data ? error.response.data : null;
    throw wrapped;
  });
}

function readXError(error) {
  if (!error.response) {
    return "无法连接 X API，请检查网络、Token 或 JSBox 网络权限。";
  }
  var data = error.response.data || {};
  var status = error.response.status;
  var allText = collectXErrorText(data);
  var userContextHint = "当前 Token 不是 OAuth 2.0 用户上下文 Token，不能读取用户点赞列表。请改用 OAuth 2.0 User Context Access Token，或使用 OAuth 1.0a User Context。生成 OAuth 2.0 用户 Token 时至少需要 tweet.read、users.read、like.read；如需长期使用，请包含 offline.access 并在过期后刷新 Token。";
  if (isAppOnlyForbiddenForUserEndpoint(allText)) {
    return userContextHint;
  }
  if (isQuotaOrRateError(status, allText)) {
    return "X API 额度、余额或速率限制不足。请到 Developer Console 检查额度或账单，或等待速率限制重置。";
  }
  if (status === 401 || isExpiredTokenError(allText)) {
    return "Access Token 可能已过期或无效。请使用 refresh token 刷新，或重新完成 OAuth 2.0 用户授权。";
  }
  if (data.detail) {
    return data.detail;
  }
  if (data.title) {
    return data.title;
  }
  if (data.errors && data.errors.length) {
    var first = data.errors[0];
    var message = first.message || first.detail || first.title || "";
    return message || "X API 返回错误。";
  }
  return "X API 返回 HTTP " + error.response.status + "。";
}

function collectXErrorText(data) {
  var parts = [];
  if (data) {
    if (data.detail) {
      parts.push(data.detail);
    }
    if (data.title) {
      parts.push(data.title);
    }
    if (data.reason) {
      parts.push(data.reason);
    }
    safeArray(data.errors).forEach(function (item) {
      if (item.message) {
        parts.push(item.message);
      }
      if (item.detail) {
        parts.push(item.detail);
      }
      if (item.title) {
        parts.push(item.title);
      }
      if (item.reason) {
        parts.push(item.reason);
      }
    });
  }
  return parts.join(" ");
}

function isAppOnlyForbiddenForUserEndpoint(message) {
  var text = String(message || "").toLowerCase();
  return text.indexOf("authenticating with oauth 2.0 application-only is forbidden") !== -1 ||
    text.indexOf("authenticating with app-only is forbidden") !== -1;
}

function isExpiredTokenError(message) {
  var text = String(message || "").toLowerCase();
  return text.indexOf("expired") !== -1 || text.indexOf("invalid token") !== -1 || text.indexOf("unauthorized") !== -1;
}

function isQuotaOrRateError(status, message) {
  var text = String(message || "").toLowerCase();
  if (status === 429) {
    return true;
  }
  return text.indexOf("usage cap") !== -1 ||
    text.indexOf("monthly") !== -1 ||
    text.indexOf("quota") !== -1 ||
    text.indexOf("balance") !== -1 ||
    text.indexOf("credit") !== -1 ||
    text.indexOf("billing") !== -1 ||
    text.indexOf("too many requests") !== -1 ||
    text.indexOf("rate limit") !== -1 ||
    text.indexOf("limit exceeded") !== -1;
}

function shouldAttemptTokenRefresh(error) {
  if (!error.response) {
    return false;
  }
  var data = error.response.data || {};
  var text = collectXErrorText(data);
  if (isAppOnlyForbiddenForUserEndpoint(text) || isQuotaOrRateError(error.response.status, text)) {
    return false;
  }
  return error.response.status === 401 || isExpiredTokenError(text);
}

function canRefreshToken(settings) {
  return !!(settings && settings.refreshToken && settings.clientId);
}

function refreshAccessToken(settings, db) {
  var requestId = logger.nextId("xauth");
  var startedAt = Date.now();
  if (!settings.refreshToken || !settings.clientId) {
    var missing = new Error("需要 refresh token 和 OAuth 2.0 Client ID 才能刷新 Access Token。");
    missing.statusCode = 400;
    logger.error("xauth.refresh.missing_config", {
      id: requestId,
      error: logger.errorToObject(missing)
    });
    throw missing;
  }
  var payload = {
    refresh_token: settings.refreshToken,
    grant_type: "refresh_token"
  };
  var headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "xLikes/1.0"
  };
  if (settings.clientSecret) {
    headers.Authorization = "Basic " + Buffer.from(settings.clientId + ":" + settings.clientSecret).toString("base64");
  } else {
    payload.client_id = settings.clientId;
  }
  logger.info("xauth.refresh.request", {
    id: requestId,
    url: X_API_BASE + "/2/oauth2/token",
    payload: payload,
    hasClientSecret: !!settings.clientSecret
  });
  return axios({
    method: "post",
    url: X_API_BASE + "/2/oauth2/token",
    data: querystring.stringify(payload),
    headers: headers,
    timeout: 45000,
    validateStatus: function (status) {
      return status >= 200 && status < 300;
    }
  }).then(function (response) {
    var data = response.data || {};
    logger.info("xauth.refresh.response", {
      id: requestId,
      durationMs: Date.now() - startedAt,
      status: response.status,
      headers: headersForLog(response.headers),
      data: data
    });
    if (!data.access_token) {
      var noToken = new Error("X API 没有返回新的 access_token。");
      noToken.statusCode = 502;
      throw noToken;
    }
    settings.accessToken = data.access_token;
    if (data.refresh_token) {
      settings.refreshToken = data.refresh_token;
    }
    settings.tokenExpiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : "";
    logger.setEnvValues({
      X_ACCESS_TOKEN: settings.accessToken,
      X_REFRESH_TOKEN: settings.refreshToken,
      X_TOKEN_EXPIRES_AT: settings.tokenExpiresAt
    });
    settings.lastTokenRefreshAt = nowIso();
    settings.lastTokenRefreshError = "";
    if (db) {
      writeSettings(db, settings);
    }
    return settings;
  }).catch(function (error) {
    var message = error.response ? readXError(error) : error.message;
    logger.error("xauth.refresh.error", {
      id: requestId,
      durationMs: Date.now() - startedAt,
      status: error.response && error.response.status ? error.response.status : null,
      headers: error.response && error.response.headers ? headersForLog(error.response.headers) : null,
      data: error.response && error.response.data ? error.response.data : null,
      error: logger.errorToObject(error)
    });
    settings.lastTokenRefreshError = message || "刷新失败";
    if (db) {
      writeSettings(db, settings);
    }
    var wrapped = new Error(message || "刷新 Access Token 失败。");
    wrapped.statusCode = error.response && error.response.status ? error.response.status : error.statusCode || 502;
    wrapped.detail = error.response && error.response.data ? error.response.data : null;
    throw wrapped;
  });
}

function updateAuthenticatedUser(settings, user) {
  if (!user || !user.id) {
    var err = new Error("X API 没有返回当前授权用户 ID。请确认使用的是 OAuth 2.0 User Context Access Token。");
    err.statusCode = 502;
    throw err;
  }
  settings.userId = user.id || "";
  settings.name = user.name || "";
  settings.username = user.username || "";
  settings.profileImageUrl = user.profile_image_url || "";
  settings.lastAccountCheck = nowIso();
}

function fetchAuthenticatedUser(settings, db) {
  return xRequest(settings, "get", "/2/users/me", {
    "user.fields": "id,name,username,profile_image_url,verified"
  }, null, db).then(function (response) {
    var user = response.data && response.data.data ? response.data.data : {};
    updateAuthenticatedUser(settings, user);
    if (db) {
      writeSettings(db, settings);
    }
    return settings;
  });
}

function fetchUserById(settings, db, userId) {
  logger.info("user.refresh.request", {
    userId: userId
  });
  return xRequest(settings, "get", "/2/users/" + encodeURIComponent(userId), {
    "user.fields": "id,name,username,profile_image_url,verified"
  }, null, db).then(function (response) {
    var user = response.data && response.data.data ? response.data.data : {};
    if (!user || !user.id) {
      var err = new Error("X API 没有返回用户信息。");
      err.statusCode = 502;
      throw err;
    }
    logger.info("user.refresh.response", {
      userId: user.id,
      username: user.username || "",
      name: user.name || "",
      hasProfileImageUrl: !!user.profile_image_url
    });
    return user;
  });
}

function updateAuthorObject(author, user) {
  if (!author) {
    author = {};
  }
  author.id = user.id || author.id || "";
  author.name = user.name || "";
  author.username = user.username || "";
  author.profileImageUrl = user.profile_image_url || "";
  author.verified = !!user.verified;
  return author;
}

function updateTweetsForUser(db, settings, user) {
  var tweets = db.get("tweets").value();
  var updated = 0;
  var referencedUpdated = 0;
  safeArray(tweets).forEach(function (tweet) {
    var authorId = tweet.authorId || (tweet.author && tweet.author.id ? tweet.author.id : "");
    if (String(authorId) === String(user.id)) {
      tweet.authorId = user.id;
      tweet.author = updateAuthorObject(tweet.author, user);
      tweet.localUpdatedAt = nowIso();
      updated += 1;
    }
    safeArray(tweet.referencedTweets).forEach(function (item) {
      if (item.author && String(item.author.id || "") === String(user.id)) {
        item.author = updateAuthorObject(item.author, user);
        tweet.localUpdatedAt = nowIso();
        referencedUpdated += 1;
      }
    });
  });
  if (settings && String(settings.userId || "") === String(user.id)) {
    updateAuthenticatedUser(settings, user);
    writeSettings(db, settings);
  } else {
    db.write();
  }
  logger.info("user.refresh.local_update", {
    userId: user.id,
    updatedTweets: updated,
    updatedReferences: referencedUpdated
  });
  return {
    user: {
      id: user.id || "",
      name: user.name || "",
      username: user.username || "",
      profileImageUrl: user.profile_image_url || "",
      verified: !!user.verified
    },
    updatedTweets: updated,
    updatedReferences: referencedUpdated
  };
}

function ensureAuthenticatedUser(settings, db) {
  if (settings.userId) {
    return Promise.resolve(settings);
  }
  return fetchAuthenticatedUser(settings, db);
}

function rateLimitFromHeaders(headers) {
  if (!headers) {
    return null;
  }
  return {
    limit: headers["x-rate-limit-limit"] || "",
    remaining: headers["x-rate-limit-remaining"] || "",
    reset: headers["x-rate-limit-reset"] || ""
  };
}

function sendOk(res, data) {
  res.json({
    ok: true,
    data: data
  });
}

function findTweet(tweets, id) {
  for (var i = 0; i < tweets.length; i += 1) {
    if (String(tweets[i].id) === String(id)) {
      return tweets[i];
    }
  }
  return null;
}

function isSameTag(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function cleanTag(tag) {
  var value = String(tag || "").replace(/^#+/, "").trim();
  value = value.replace(/\s+/g, " ");
  if (value.length > 32) {
    value = value.slice(0, 32);
  }
  return value;
}

function safeArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]" ? value : [];
}

function indexBy(list, key) {
  var map = {};
  safeArray(list).forEach(function (item) {
    if (item && item[key]) {
      map[item[key]] = item;
    }
  });
  return map;
}

function selectBestVideoUrl(media) {
  var variants = safeArray(media.variants);
  var best = null;
  variants.forEach(function (variant) {
    if (!variant || !variant.url) {
      return;
    }
    if (variant.content_type && variant.content_type.indexOf("mp4") === -1) {
      return;
    }
    if (!best || (variant.bit_rate || 0) > (best.bit_rate || 0)) {
      best = variant;
    }
  });
  return best ? best.url : "";
}

function normalizeMedia(media) {
  var type = media.type || "";
  var downloadUrl = media.url || "";
  if ((type === "video" || type === "animated_gif") && !downloadUrl) {
    downloadUrl = selectBestVideoUrl(media);
  }
  return {
    mediaKey: media.media_key || "",
    type: type,
    url: media.url || "",
    downloadUrl: downloadUrl,
    previewImageUrl: media.preview_image_url || "",
    durationMs: typeof media.duration_ms === "number" ? media.duration_ms : 0,
    width: media.width || 0,
    height: media.height || 0,
    altText: media.alt_text || "",
    localPath: "",
    status: type === "video" && media.duration_ms > LONG_VIDEO_MS ? "deferred" : "remote",
    error: "",
    downloadedAt: "",
    publicMetrics: media.public_metrics || null
  };
}

function normalizeTweet(tweet, usersById, mediaByKey, referencedById) {
  var media = [];
  var keys = tweet.attachments && tweet.attachments.media_keys ? tweet.attachments.media_keys : [];
  safeArray(keys).forEach(function (key) {
    if (mediaByKey[key]) {
      media.push(normalizeMedia(mediaByKey[key]));
    }
  });

  var referenced = [];
  safeArray(tweet.referenced_tweets).forEach(function (ref) {
    var related = referencedById[ref.id] || null;
    var author = related && usersById[related.author_id] ? usersById[related.author_id] : null;
    referenced.push({
      type: ref.type || "",
      id: ref.id,
      text: related ? related.text || "" : "",
      author: author ? {
        id: author.id || "",
        name: author.name || "",
        username: author.username || "",
        profileImageUrl: author.profile_image_url || ""
      } : null
    });
  });

  var authorData = usersById[tweet.author_id] || {};
  return {
    id: tweet.id,
    text: tweet.text || "",
    createdAt: tweet.created_at || "",
    authorId: tweet.author_id || "",
    author: {
      id: authorData.id || tweet.author_id || "",
      name: authorData.name || "",
      username: authorData.username || "",
      profileImageUrl: authorData.profile_image_url || "",
      verified: !!authorData.verified
    },
    publicMetrics: tweet.public_metrics || {},
    entities: tweet.entities || null,
    attachments: tweet.attachments || null,
    referencedTweets: referenced,
    media: media,
    lang: tweet.lang || "",
    possiblySensitive: !!tweet.possibly_sensitive,
    raw: tweet
  };
}

function normalizeLikedResponse(body) {
  var includes = body.includes || {};
  var usersById = indexBy(includes.users, "id");
  var mediaByKey = indexBy(includes.media, "media_key");
  var referencedById = indexBy(includes.tweets, "id");
  return safeArray(body.data).map(function (tweet) {
    return normalizeTweet(tweet, usersById, mediaByKey, referencedById);
  });
}

function mergeMedia(existingMedia, incomingMedia) {
  var oldByKey = indexBy(existingMedia, "mediaKey");
  var merged = [];
  safeArray(incomingMedia).forEach(function (media) {
    var old = oldByKey[media.mediaKey] || {};
    merged.push(Object.assign({}, media, {
      localPath: old.localPath || media.localPath || "",
      status: old.localPath ? "downloaded" : (old.status || media.status || "remote"),
      error: old.error || "",
      downloadedAt: old.downloadedAt || ""
    }));
    delete oldByKey[media.mediaKey];
  });
  Object.keys(oldByKey).forEach(function (key) {
    merged.push(oldByKey[key]);
  });
  return merged;
}

function applyIncomingTweet(existing, incoming, sortOrder) {
  var oldMedia = existing.media;
  var preserved = {
    rating: existing.rating || 0,
    tags: safeArray(existing.tags),
    note: existing.note || "",
    archived: !!existing.archived,
    localCreatedAt: existing.localCreatedAt || nowIso(),
    sortOrder: existing.sortOrder || sortOrder
  };
  Object.keys(incoming).forEach(function (key) {
    existing[key] = incoming[key];
  });
  existing.rating = preserved.rating;
  existing.tags = preserved.tags;
  existing.note = preserved.note;
  existing.archived = preserved.archived;
  existing.localCreatedAt = preserved.localCreatedAt;
  existing.sortOrder = typeof sortOrder === "number" ? sortOrder : preserved.sortOrder;
  existing.localUpdatedAt = nowIso();
  existing.media = mergeMedia(oldMedia, incoming.media);
  return existing;
}

function upsertTweet(tweets, incoming, sortOrder) {
  var existing = findTweet(tweets, incoming.id);
  if (existing) {
    applyIncomingTweet(existing, incoming, sortOrder);
    return "updated";
  }
  incoming.rating = 0;
  incoming.tags = [];
  incoming.note = "";
  incoming.archived = false;
  incoming.localCreatedAt = nowIso();
  incoming.localUpdatedAt = nowIso();
  incoming.sortOrder = sortOrder;
  tweets.push(incoming);
  return "added";
}

function tweetLookupParams() {
  return {
    "tweet.fields": "id,text,created_at,author_id,public_metrics,entities,attachments,referenced_tweets,conversation_id,lang,possibly_sensitive",
    "user.fields": "id,name,username,profile_image_url,verified",
    "media.fields": "media_key,type,url,preview_image_url,duration_ms,width,height,alt_text,variants,public_metrics",
    expansions: "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
  };
}

function refreshTweetFromX(settings, db, tweet) {
  logger.info("tweet.refresh.request", {
    tweetId: tweet.id
  });
  return xRequest(settings, "get", "/2/tweets/" + encodeURIComponent(tweet.id), tweetLookupParams(), null, db).then(function (response) {
    var body = response.data || {};
    var includes = body.includes || {};
    var usersById = indexBy(includes.users, "id");
    var mediaByKey = indexBy(includes.media, "media_key");
    var referencedById = indexBy(includes.tweets, "id");
    var incoming;
    if (!body.data || !body.data.id) {
      var err = new Error("X API 没有返回推文媒体信息。");
      err.statusCode = 502;
      throw err;
    }
    incoming = normalizeTweet(body.data, usersById, mediaByKey, referencedById);
    applyIncomingTweet(tweet, incoming);
    db.write();
    logger.info("tweet.refresh.response", {
      tweetId: tweet.id,
      mediaCount: safeArray(tweet.media).length,
      authorId: tweet.authorId || ""
    });
    return tweet;
  });
}

function likedTweetParams(nextToken, maxResults) {
  var pageSize = Number(maxResults || LIKED_TWEETS_FULL_MAX_RESULTS);
  if (!pageSize || pageSize < 1) {
    pageSize = 1;
  }
  if (pageSize > 100) {
    pageSize = 100;
  }
  var params = {
    max_results: pageSize,
    "tweet.fields": "id,text,created_at,author_id,public_metrics,entities,attachments,referenced_tweets,conversation_id,lang,possibly_sensitive",
    "user.fields": "id,name,username,profile_image_url,verified",
    "media.fields": "media_key,type,url,preview_image_url,duration_ms,width,height,alt_text,variants,public_metrics",
    expansions: "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
  };
  if (nextToken) {
    params.pagination_token = nextToken;
  }
  return params;
}

function sortTweetsForList(tweets) {
  return tweets.slice().sort(function (a, b) {
    var ao = typeof a.sortOrder === "number" ? a.sortOrder : 0;
    var bo = typeof b.sortOrder === "number" ? b.sortOrder : 0;
    if (bo !== ao) {
      return bo - ao;
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

function tweetMatches(tweet, query, includeArchived, minRating) {
  if (!includeArchived && tweet.archived) {
    return false;
  }
  if (minRating && (tweet.rating || 0) < minRating) {
    return false;
  }
  var q = String(query || "").trim().toLowerCase();
  if (!q) {
    return true;
  }
  var tags = safeArray(tweet.tags);
  var haystack = [
    tweet.text || "",
    tweet.note || "",
    tweet.author && tweet.author.name ? tweet.author.name : "",
    tweet.author && tweet.author.username ? tweet.author.username : "",
    tags.join(" ")
  ].join(" ").toLowerCase();
  var parts = q.split(/\s+/);
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (!part) {
      continue;
    }
    if (part.charAt(0) === "#") {
      var tagNeedle = part.slice(1);
      var hasTag = false;
      for (var j = 0; j < tags.length; j += 1) {
        if (String(tags[j]).toLowerCase().indexOf(tagNeedle) !== -1) {
          hasTag = true;
          break;
        }
      }
      if (!hasTag) {
        return false;
      }
    } else if (haystack.indexOf(part) === -1) {
      return false;
    }
  }
  return true;
}

function tweetMediaDownloadState(tweet) {
  var media = safeArray(tweet.media);
  var hasMedia = false;
  var allDownloaded = true;
  media.forEach(function (item) {
    hasMedia = true;
    if (!item || !item.localPath) {
      allDownloaded = false;
    }
  });
  if (!hasMedia) {
    return "";
  }
  return allDownloaded ? "yes" : "no";
}

function tweetMatchesMediaDownload(tweet, mode) {
  var normalized = mode === "yes" || mode === "no" ? mode : "";
  if (!normalized) {
    return true;
  }
  return tweetMediaDownloadState(tweet) === normalized;
}

function tagCounts(tweets) {
  var counts = {};
  safeArray(tweets).forEach(function (tweet) {
    safeArray(tweet.tags).forEach(function (tag) {
      if (!tag) {
        return;
      }
      var key = tag.toLowerCase();
      if (!counts[key]) {
        counts[key] = {
          tag: tag,
          count: 0
        };
      }
      counts[key].count += 1;
    });
  });
  return Object.keys(counts).map(function (key) {
    return counts[key];
  });
}

function sortedTags(db, sortMode) {
  var tags = tagCounts(db.get("tweets").value());
  if (sortMode === "name") {
    tags.sort(function (a, b) {
      return a.tag.localeCompare(b.tag);
    });
  } else {
    tags.sort(function (a, b) {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.tag.localeCompare(b.tag);
    });
  }
  return tags;
}

function addSearchHistory(settings, query) {
  var q = String(query || "").trim();
  if (!q) {
    return;
  }
  var history = safeArray(settings.searchHistory).filter(function (item) {
    return String(item).toLowerCase() !== q.toLowerCase();
  });
  history.unshift(q);
  settings.searchHistory = history.slice(0, 20);
}

function tweetDateKey(tweet) {
  var value = tweet && tweet.createdAt ? String(tweet.createdAt) : "";
  return value.length >= 10 ? value.slice(0, 10) : "";
}

function tweetInDateRange(tweet, startDate, endDate) {
  var key = tweetDateKey(tweet);
  if (!key) {
    return !startDate && !endDate;
  }
  if (startDate && key < startDate) {
    return false;
  }
  if (endDate && key > endDate) {
    return false;
  }
  return true;
}

function hashForRandomSort(value) {
  var text = String(value || "");
  var hash = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function sortSearchTweets(tweets, sortMode, seed) {
  var sorted = sortTweetsForList(tweets);
  if (sortMode === "reverse") {
    return sorted.reverse();
  }
  if (sortMode === "random") {
    return sorted.sort(function (a, b) {
      var ah = hashForRandomSort(String(seed || "") + ":" + String(a.id || ""));
      var bh = hashForRandomSort(String(seed || "") + ":" + String(b.id || ""));
      if (ah !== bh) {
        return ah - bh;
      }
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
  }
  if (sortMode === "created_asc" || sortMode === "created_desc") {
    sorted.sort(function (a, b) {
      var cmp = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      if (cmp === 0) {
        return String(a.id || "").localeCompare(String(b.id || ""));
      }
      return cmp;
    });
    if (sortMode === "created_desc") {
      sorted.reverse();
    }
    return sorted;
  }
  return sorted;
}

function parseBool(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function extensionFromMedia(media, remoteUrl, contentType) {
  if (media.type === "video" || media.type === "animated_gif") {
    return ".mp4";
  }
  if (contentType && contentType.indexOf("png") !== -1) {
    return ".png";
  }
  if (contentType && contentType.indexOf("webp") !== -1) {
    return ".webp";
  }
  var pathname = url.parse(remoteUrl).pathname || "";
  var ext = path.extname(pathname).toLowerCase();
  if (ext && ext.length <= 6) {
    return ext;
  }
  return ".jpg";
}

function mediaDownloadKey(tweetId) {
  return String(tweetId || "");
}

function mediaRemoteUrl(media) {
  return media.downloadUrl || media.url || "";
}

function shouldDownloadMedia(media, forceLong) {
  if (!media || media.localPath) {
    return false;
  }
  if (media.type === "video" && media.durationMs > LONG_VIDEO_MS && !forceLong) {
    return false;
  }
  var remoteUrl = mediaRemoteUrl(media);
  return !!(remoteUrl && /^https?:\/\//i.test(remoteUrl));
}

function createMediaDownloadJob(tweet, forceLong) {
  var media = safeArray(tweet.media);
  var items = [];
  media.forEach(function (item) {
    if (shouldDownloadMedia(item, forceLong)) {
      items.push({
        mediaKey: item.mediaKey || "",
        type: item.type || "",
        totalBytes: 0,
        downloadedBytes: 0,
        percent: 0,
        status: "queued",
        error: ""
      });
    }
  });
  return {
    tweetId: tweet.id,
    status: items.length ? "queued" : "completed",
    startedAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: items.length ? "" : nowIso(),
    forceLong: !!forceLong,
    currentMediaKey: "",
    currentIndex: 0,
    mediaCount: items.length,
    completedCount: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    percent: items.length ? 0 : 100,
    message: items.length ? "等待下载" : "没有需要下载的媒体",
    error: "",
    media: items
  };
}

function publicMediaDownloadJob(job) {
  if (!job) {
    return null;
  }
  return {
    tweetId: job.tweetId,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    forceLong: job.forceLong,
    currentMediaKey: job.currentMediaKey,
    currentIndex: job.currentIndex,
    mediaCount: job.mediaCount,
    completedCount: job.completedCount,
    totalBytes: job.totalBytes,
    downloadedBytes: job.downloadedBytes,
    percent: job.percent,
    message: job.message,
    error: job.error,
    media: job.media
  };
}

function findMediaProgress(job, media) {
  if (!job) {
    return null;
  }
  var key = media.mediaKey || "";
  for (var i = 0; i < job.media.length; i += 1) {
    if (job.media[i].mediaKey === key) {
      return job.media[i];
    }
  }
  return null;
}

function recalcDownloadJob(job) {
  if (!job) {
    return;
  }
  var totalBytes = 0;
  var downloadedBytes = 0;
  var completed = 0;
  var currentPercent = 0;
  safeArray(job.media).forEach(function (item) {
    totalBytes += item.totalBytes || 0;
    downloadedBytes += item.downloadedBytes || 0;
    if (item.status === "downloaded" || item.status === "skipped") {
      completed += 1;
    }
    if (item.mediaKey === job.currentMediaKey) {
      currentPercent = item.percent || 0;
    }
  });
  job.totalBytes = totalBytes;
  job.downloadedBytes = downloadedBytes;
  job.completedCount = completed;
  if (job.mediaCount) {
    job.percent = Math.min(100, Math.round(((completed + currentPercent / 100) / job.mediaCount) * 100));
  } else {
    job.percent = 100;
  }
  job.updatedAt = nowIso();
}

function startMediaDownloadJob(req, tweet, forceLong) {
  var key = mediaDownloadKey(tweet.id);
  var existing = mediaDownloadJobs[key];
  if (existing && (existing.status === "queued" || existing.status === "downloading")) {
    logger.info("media.download.reuse_job", {
      tweetId: tweet.id,
      progress: publicMediaDownloadJob(existing)
    });
    return existing;
  }
  var db = getDb(req);
  var job = createMediaDownloadJob(tweet, forceLong);
  mediaDownloadJobs[key] = job;
  logger.info("media.download.start", {
    tweetId: tweet.id,
    forceLong: !!forceLong,
    mediaCount: job.mediaCount,
    progress: publicMediaDownloadJob(job)
  });
  if (!job.mediaCount) {
    return job;
  }
  var context = {
    mediaDir: req.app.locals.mediaDir
  };
  downloadTweetMedia(context, tweet, forceLong, job).then(function () {
    tweet.localUpdatedAt = nowIso();
    job.status = job.error ? "error" : "completed";
    job.finishedAt = nowIso();
    recalcDownloadJob(job);
    if (job.status === "completed") {
      job.percent = 100;
      job.message = "下载完成";
    }
    logger.info("media.download.finish", {
      tweetId: tweet.id,
      progress: publicMediaDownloadJob(job)
    });
    db.write();
  }).catch(function (err) {
    job.status = "error";
    job.error = err.message || "下载失败";
    job.message = job.error;
    job.finishedAt = nowIso();
    recalcDownloadJob(job);
    tweet.localUpdatedAt = nowIso();
    logger.error("media.download.error", {
      tweetId: tweet.id,
      progress: publicMediaDownloadJob(job),
      error: logger.errorToObject(err)
    });
    db.write();
  });
  return job;
}

function downloadTweetMedia(context, tweet, forceLong, job) {
  var mediaDir = context.mediaDir;
  var changed = false;
  var chain = Promise.resolve();

  safeArray(tweet.media).forEach(function (media) {
    chain = chain.then(function () {
      if (media.localPath) {
        return null;
      }
      if (media.type === "video" && media.durationMs > LONG_VIDEO_MS && !forceLong) {
        media.status = "deferred";
        changed = true;
        return null;
      }
      var remoteUrl = mediaRemoteUrl(media);
      if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
        media.status = "error";
        media.error = "媒体没有可下载的远程地址。";
        changed = true;
        return null;
      }
      var mediaProgress = findMediaProgress(job, media);
      if (mediaProgress) {
        job.status = "downloading";
        job.currentMediaKey = mediaProgress.mediaKey;
        job.currentIndex = Math.max(1, safeArray(job.media).indexOf(mediaProgress) + 1);
        job.message = "正在下载媒体 " + job.currentIndex + "/" + job.mediaCount;
        mediaProgress.status = "downloading";
        mediaProgress.error = "";
        recalcDownloadJob(job);
      }
      media.status = "downloading";
      changed = true;
      var ext = extensionFromMedia(media, remoteUrl, "");
      var fileName = String(tweet.id) + "_" + String(media.mediaKey || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "") + ext;
      var destPath = path.join(mediaDir, fileName);
      logger.info("media.file.request", {
        tweetId: tweet.id,
        mediaKey: media.mediaKey || "",
        type: media.type || "",
        url: remoteUrl,
        fileName: fileName
      });
      return axios({
        method: "get",
        url: remoteUrl,
        responseType: "stream",
        timeout: 120000
      }).then(function (response) {
        var contentType = response.headers ? response.headers["content-type"] || "" : "";
        logger.info("media.file.response", {
          tweetId: tweet.id,
          mediaKey: media.mediaKey || "",
          status: response.status,
          headers: headersForLog(response.headers)
        });
        var finalExt = extensionFromMedia(media, remoteUrl, contentType);
        if (finalExt !== ext) {
          fileName = String(tweet.id) + "_" + String(media.mediaKey || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "") + finalExt;
          destPath = path.join(mediaDir, fileName);
        }
        if (mediaProgress) {
          mediaProgress.totalBytes = Number(response.headers && response.headers["content-length"] ? response.headers["content-length"] : 0);
          mediaProgress.downloadedBytes = 0;
          mediaProgress.percent = mediaProgress.totalBytes ? 0 : 0;
          recalcDownloadJob(job);
        }
        return new Promise(function (resolve, reject) {
          var stream = fs.createWriteStream(destPath);
          response.data.on("data", function (chunk) {
            if (mediaProgress) {
              mediaProgress.downloadedBytes += chunk && chunk.length ? chunk.length : 0;
              if (mediaProgress.totalBytes) {
                mediaProgress.percent = Math.min(100, Math.round((mediaProgress.downloadedBytes / mediaProgress.totalBytes) * 100));
              }
              recalcDownloadJob(job);
            }
          });
          response.data.pipe(stream);
          stream.on("finish", resolve);
          stream.on("error", reject);
          response.data.on("error", reject);
        });
      }).then(function () {
        media.localPath = "/media/" + fileName;
        media.status = "downloaded";
        media.error = "";
        media.downloadedAt = nowIso();
        if (mediaProgress) {
          mediaProgress.status = "downloaded";
          if (!mediaProgress.totalBytes) {
            mediaProgress.totalBytes = mediaProgress.downloadedBytes;
          }
          mediaProgress.percent = 100;
          recalcDownloadJob(job);
        }
        changed = true;
        logger.info("media.file.finish", {
          tweetId: tweet.id,
          mediaKey: media.mediaKey || "",
          localPath: media.localPath,
          progress: mediaProgress || null
        });
      }).catch(function (err) {
        media.status = "error";
        media.error = err.message || "下载失败";
        if (mediaProgress) {
          mediaProgress.status = "error";
          mediaProgress.error = media.error;
          recalcDownloadJob(job);
        }
        if (job) {
          job.error = media.error;
          job.message = media.error;
        }
        logger.error("media.file.error", {
          tweetId: tweet.id,
          mediaKey: media.mediaKey || "",
          error: logger.errorToObject(err)
        });
        changed = true;
      });
    });
  });

  return chain.then(function () {
    return changed;
  });
}

function syncLikedTweets(req, mode) {
  var db = getDb(req);
  var settings = getSettings(db);
  var tweets = db.get("tweets").value();
  var existingIds = {};
  var nextToken = "";
  var pageCount = 0;
  var added = 0;
  var updated = 0;
  var stoppedByDuplicate = false;
  var startedAt = Date.now();
  var sequence = 0;
  var lastRateLimit = null;
  var pageSize = mode === "incremental" ? LIKED_TWEETS_INCREMENTAL_MAX_RESULTS : LIKED_TWEETS_FULL_MAX_RESULTS;

  safeArray(tweets).forEach(function (tweet) {
    existingIds[tweet.id] = true;
  });

  db.set("sync.lastMode", mode)
    .set("sync.lastStartedAt", nowIso())
    .set("sync.lastFinishedAt", "")
    .set("sync.lastError", "")
    .write();

  function nextPage() {
    requireUserId(settings);
    return xRequest(settings, "get", "/2/users/" + encodeURIComponent(settings.userId) + "/liked_tweets", likedTweetParams(nextToken, pageSize), null, db).then(function (response) {
      pageCount += 1;
      lastRateLimit = rateLimitFromHeaders(response.headers);
      var body = response.data || {};
      var list = normalizeLikedResponse(body);
      for (var i = 0; i < list.length; i += 1) {
        var incoming = list[i];
        if (mode === "incremental" && existingIds[incoming.id]) {
          stoppedByDuplicate = true;
          break;
        }
        var result = upsertTweet(tweets, incoming, startedAt * 1000 - sequence);
        sequence += 1;
        existingIds[incoming.id] = true;
        if (result === "added") {
          added += 1;
        } else {
          updated += 1;
        }
      }
      db.set("sync.lastRateLimit", lastRateLimit).write();
      nextToken = body.meta && body.meta.next_token ? body.meta.next_token : "";
      if (stoppedByDuplicate || !nextToken || pageCount >= 1000) {
        return null;
      }
      return nextPage();
    });
  }

  return ensureAuthenticatedUser(settings, db).then(function () {
    return nextPage();
  }).then(function () {
    var summary = {
      mode: mode,
      pages: pageCount,
      added: added,
      updated: updated,
      stoppedByDuplicate: stoppedByDuplicate,
      maxResults: pageSize,
      rateLimit: lastRateLimit,
      finishedAt: nowIso()
    };
    db.set("sync.lastFinishedAt", summary.finishedAt)
      .set("sync.lastSummary", summary)
      .write();
    return summary;
  }).catch(function (err) {
    db.set("sync.lastFinishedAt", nowIso())
      .set("sync.lastError", err.message || "同步失败")
      .write();
    throw err;
  });
}

router.get("/status", function (req, res) {
  var db = getDb(req);
  var settings = getSettings(db);
  var tweets = db.get("tweets").value();
  sendOk(res, {
    settings: publicSettings(settings),
    stats: {
      totalTweets: tweets.length,
      archivedTweets: tweets.filter(function (tweet) { return !!tweet.archived; }).length,
      taggedTweets: tweets.filter(function (tweet) { return safeArray(tweet.tags).length > 0; }).length
    },
    sync: db.get("sync").value(),
    isJsbox: !!req.app.locals.isJsbox
  });
});

router.post("/settings", function (req, res) {
  var db = getDb(req);
  var settings = getSettings(db);
  var body = req.body || {};
  var credentialUpdates = credentialEnvUpdateFromBody(body);
  if (Object.keys(credentialUpdates).length) {
    logger.setEnvValues(credentialUpdates);
    applyCredentialEnvUpdate(settings, credentialUpdates);
  }
  if (typeof body.userId === "string") {
    settings.userId = body.userId.trim();
  }
  if (typeof body.autoSyncOnStart !== "undefined") {
    settings.autoSyncOnStart = !!body.autoSyncOnStart;
  }
  if (!settings.createdAt) {
    settings.createdAt = nowIso();
  }
  writeSettings(db, settings);
  sendOk(res, publicSettings(settings));
});

router.post("/auth/test", function (req, res, next) {
  var db = getDb(req);
  var settings = getSettings(db);
  fetchAuthenticatedUser(settings, db).then(function () {
    // Validate the actual endpoint used by sync. User lookup can succeed with
    // app-only auth, but liked_tweets requires user-context auth.
    var params = likedTweetParams("", LIKED_TWEETS_AUTH_TEST_MAX_RESULTS);
    requireUserId(settings);
    return xRequest(settings, "get", "/2/users/" + encodeURIComponent(settings.userId) + "/liked_tweets", params, null, db);
  }).then(function () {
    writeSettings(db, settings);
    sendOk(res, publicSettings(settings));
  }).catch(next);
});

router.post("/auth/refresh", function (req, res, next) {
  var db = getDb(req);
  var settings = getSettings(db);
  refreshAccessToken(settings, db).then(function () {
    sendOk(res, publicSettings(settings));
  }).catch(next);
});

router.post("/sync", function (req, res, next) {
  var mode = req.body && req.body.mode === "full" ? "full" : "incremental";
  syncLikedTweets(req, mode).then(function (summary) {
    sendOk(res, summary);
  }).catch(next);
});

router.get("/tweets", function (req, res) {
  var db = getDb(req);
  var offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  var limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 100);
  var includeArchived = parseBool(req.query.includeArchived);
  var minRating = parseInt(req.query.minRating || "0", 10);
  var q = req.query.q || "";
  var all = sortTweetsForList(db.get("tweets").value()).filter(function (tweet) {
    return tweetMatches(tweet, q, includeArchived, minRating);
  });
  sendOk(res, {
    items: all.slice(offset, offset + limit),
    total: all.length,
    offset: offset,
    limit: limit,
    hasMore: offset + limit < all.length
  });
});

router.get("/tweets/random", function (req, res) {
  var db = getDb(req);
  var includeArchived = parseBool(req.query.includeArchived);
  var limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
  var items = db.get("tweets").value().filter(function (tweet) {
    return includeArchived || !tweet.archived;
  });
  if (!items.length) {
    sendOk(res, {
      items: []
    });
    return;
  }
  var copy = items.slice();
  for (var i = copy.length - 1; i > 0; i -= 1) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  sendOk(res, {
    items: copy.slice(0, limit)
  });
});

router.post("/users/:id/refresh", function (req, res, next) {
  var db = getDb(req);
  var settings = getSettings(db);
  fetchUserById(settings, db, req.params.id).then(function (user) {
    sendOk(res, updateTweetsForUser(db, settings, user));
  }).catch(next);
});

router.post("/tweets/:id/rating", function (req, res) {
  var db = getDb(req);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  var rating = parseInt(req.body.rating || "0", 10);
  if (rating < 0 || rating > 5) {
    res.status(400).json({ ok: false, error: "分数必须是 1 到 5，或 0 表示清除。" });
    return;
  }
  tweet.rating = rating;
  tweet.localUpdatedAt = nowIso();
  db.write();
  sendOk(res, tweet);
});

router.post("/tweets/:id/tags", function (req, res) {
  var db = getDb(req);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  var tags = [];
  safeArray(req.body.tags).forEach(function (tag) {
    var cleaned = cleanTag(tag);
    if (!cleaned) {
      return;
    }
    for (var i = 0; i < tags.length; i += 1) {
      if (isSameTag(tags[i], cleaned)) {
        return;
      }
    }
    tags.push(cleaned);
  });
  tweet.tags = tags;
  tweet.localUpdatedAt = nowIso();
  db.write();
  sendOk(res, tweet);
});

router.post("/tweets/:id/note", function (req, res) {
  var db = getDb(req);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  tweet.note = String(req.body.note || "").slice(0, 2000);
  tweet.localUpdatedAt = nowIso();
  db.write();
  sendOk(res, tweet);
});

router.post("/tweets/:id/archive", function (req, res) {
  var db = getDb(req);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  tweet.archived = !!req.body.archived;
  tweet.localUpdatedAt = nowIso();
  db.write();
  sendOk(res, tweet);
});

router.post("/tweets/:id/media/download", function (req, res, next) {
  var db = getDb(req);
  var settings = getSettings(db);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  var forceLong = !!(req.body && req.body.forceLong);
  var refreshRemote = parseBool(req.body && req.body.refreshRemote);
  var run;
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  run = refreshRemote ? refreshTweetFromX(settings, db, tweet) : Promise.resolve(tweet);
  run.then(function (updatedTweet) {
    var job = startMediaDownloadJob(req, updatedTweet, forceLong);
    sendOk(res, {
      tweet: updatedTweet,
      progress: publicMediaDownloadJob(job)
    });
  }).catch(function (err) {
    next(err);
  });
});

router.get("/tweets/:id/media/progress", function (req, res) {
  var db = getDb(req);
  var tweet = findTweet(db.get("tweets").value(), req.params.id);
  if (!tweet) {
    res.status(404).json({ ok: false, error: "推文不存在。" });
    return;
  }
  var job = mediaDownloadJobs[mediaDownloadKey(req.params.id)];
  sendOk(res, {
    tweet: tweet,
    progress: publicMediaDownloadJob(job)
  });
});

router.post("/tweets/:id/open", function (req, res) {
  var tweetId = req.params.id;
  var webUrl = "https://x.com/i/web/status/" + encodeURIComponent(tweetId);
  var schemeUrl = "twitter://status?id=" + encodeURIComponent(tweetId);
  var jsboxApp = req.app.locals.jsboxApp;
  if (req.app.locals.isJsbox && jsboxApp && typeof jsboxApp.openURL === "function") {
    jsboxApp.openURL(schemeUrl);
    sendOk(res, {
      openedByJsbox: true,
      url: webUrl,
      schemeUrl: schemeUrl
    });
    return;
  }
  sendOk(res, {
    openedByJsbox: false,
    url: webUrl,
    schemeUrl: schemeUrl
  });
});

router.get("/tags", function (req, res) {
  var db = getDb(req);
  var settings = getSettings(db);
  var sortMode = req.query.sort || settings.tagSort || "count";
  sendOk(res, {
    sort: sortMode,
    tags: sortedTags(db, sortMode)
  });
});

router.post("/settings/tag-sort", function (req, res) {
  var db = getDb(req);
  var settings = getSettings(db);
  settings.tagSort = req.body.sort === "name" ? "name" : "count";
  writeSettings(db, settings);
  sendOk(res, publicSettings(settings));
});

router.post("/search", function (req, res) {
  var db = getDb(req);
  var settings = getSettings(db);
  var body = req.body || {};
  var offset = Math.max(parseInt(body.offset || "0", 10), 0);
  var limit = Math.min(Math.max(parseInt(body.limit || "50", 10), 1), 100);
  var minRating = parseInt(body.minRating || "0", 10);
  var includeArchived = !!body.includeArchived;
  var q = String(body.q || "").trim();
  var sortMode = body.sort === "reverse" || body.sort === "random" || body.sort === "created_asc" || body.sort === "created_desc" ? body.sort : "normal";
  var mediaDownloaded = body.mediaDownloaded === "yes" || body.mediaDownloaded === "no" ? body.mediaDownloaded : "";
  var startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || "")) ? String(body.startDate) : "";
  var endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.endDate || "")) ? String(body.endDate) : "";
  var randomSeed = String(body.randomSeed || "");
  if (sortMode === "random" && !randomSeed) {
    randomSeed = String(Date.now());
  }
  if (offset === 0) {
    addSearchHistory(settings, q);
    writeSettings(db, settings);
  }
  var all = sortSearchTweets(db.get("tweets").value().filter(function (tweet) {
    return tweetMatches(tweet, q, includeArchived, minRating) && tweetMatchesMediaDownload(tweet, mediaDownloaded) && tweetInDateRange(tweet, startDate, endDate);
  }), sortMode, randomSeed);
  sendOk(res, {
    items: all.slice(offset, offset + limit),
    total: all.length,
    offset: offset,
    limit: limit,
    hasMore: offset + limit < all.length,
    history: settings.searchHistory,
    sort: sortMode,
    mediaDownloaded: mediaDownloaded,
    randomSeed: randomSeed
  });
});

module.exports = router;
