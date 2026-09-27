"use strict";

// Exercise real routes and files in an isolated directory, never the user's database.
var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var http = require("http");
var express = require("express");
var low = require("lowdb");
var FileSync = require("lowdb/adapters/FileSync");
var router = require("../routes/api");
var root = fs.mkdtempSync(path.join(os.tmpdir(), "xlikes-media-test-"));
var mediaDir = path.join(root, "media");
fs.mkdirSync(mediaDir);
var db = low(new FileSync(path.join(root, "db.json")));
var app = express();
app.locals.db = db;
app.locals.mediaDir = mediaDir;
app.use(express.json());
app.use("/api", router);
app.use(function (err, req, res, next) {
  res.status(err.statusCode || 500).json({ ok: false, error: err.message });
});
var server;

function media(key, type, duration, local) {
  var item = {
    mediaKey: key, type: type, durationMs: duration || 0,
    localPath: local ? "/media/" + key + ".mp4" : "",
    downloadedAt: local ? "2026-09-27T00:00:00.000Z" : "",
    status: local ? "downloaded" : "remote", error: "",
    downloadUrl: "https://example.invalid/" + key + ".mp4"
  };
  if (local) {
    fs.writeFileSync(path.join(mediaDir, key + ".mp4"), "fixture");
  }
  return item;
}

function tweet(id, items, extra) {
  return Object.assign({ id: id, media: items, text: "needle", rating: 4,
    createdAt: "2026-09-26T12:00:00.000Z", tags: ["test"] }, extra || {});
}

function request(method, route, body) {
  return new Promise(function (resolve, reject) {
    var req = http.request({ hostname: "127.0.0.1", port: server.address().port,
      method: method, path: "/api" + route, headers: { "Content-Type": "application/json" } }, function (res) {
      var chunks = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) { chunks += chunk; });
      res.on("end", function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function search(types, extra) {
  var result = await request("POST", "/search", Object.assign({ mediaTypes: types }, extra || {}));
  assert.strictEqual(result.status, 200);
  return result.body.data;
}

async function remove(id) {
  return request("DELETE", "/tweets/" + id + "/media/videos");
}

function persisted(id) {
  return JSON.parse(fs.readFileSync(path.join(root, "db.json"), "utf8")).tweets.filter(function (item) {
    return item.id === id;
  })[0];
}

function cleanup(dir) {
  fs.readdirSync(dir).forEach(function (name) {
    var file = path.join(dir, name);
    if (fs.lstatSync(file).isDirectory()) { cleanup(file); }
    else { fs.unlinkSync(file); }
  });
  fs.rmdirSync(dir);
}

async function run() {
  db.setState({ settings: {}, tweets: [
    tweet("plain", []), tweet("photo", [media("photo", "photo", 0, true)]),
    tweet("gif", [media("gif", "animated_gif", 0, true)]),
    tweet("article", [], { hasArticle: true }),
    tweet("old-article", [], { textSource: "article" }),
    tweet("note", [], { hasLongText: true, textSource: "note_tweet" }),
    tweet("archived", [], { article: { title: "Article" }, archived: true }),
    tweet("mixed", [media("long", "video", 30001, true), media("long2", "video", 90000, true),
      media("short", "video", 30000, true), media("still", "photo", 0, true)])
  ] }).write();
  server = await new Promise(function (resolve, reject) {
    var listening = app.listen(0, "127.0.0.1", function () { resolve(listening); });
    listening.on("error", reject);
  });

  assert.strictEqual((await search([])).total, 7);
  assert.deepStrictEqual((await search(["photo"])).items.map(function (t) { return t.id; }).sort(), ["mixed", "photo"]);
  assert.deepStrictEqual((await search(["video"])).items.map(function (t) { return t.id; }).sort(), ["gif", "mixed"]);
  assert.strictEqual((await search(["article"])).total, 2);
  assert.strictEqual((await search(["article"], { includeArchived: true })).total, 3);
  assert.strictEqual((await search(["photo", "video"])).total, 3);
  assert.strictEqual((await search(["photo", "video", "article"])).total, 5);
  assert.strictEqual((await search(["photo"], { mediaDownloaded: "yes", q: "needle #test", minRating: 4,
    startDate: "2026-09-26", endDate: "2026-09-26" })).total, 2);
  assert.strictEqual((await search(["photo"], { minRating: 5 })).total, 0);
  var firstPage = await search(["photo", "article"], { limit: 1 });
  var secondPage = await search(["photo", "article"], { limit: 1, offset: 1 });
  assert.strictEqual(firstPage.total, 4);
  assert.strictEqual(firstPage.hasMore, true);
  assert.notStrictEqual(firstPage.items[0].id, secondPage.items[0].id);

  var result = await remove("mixed");
  assert.strictEqual(result.status, 200);
  var saved = persisted("mixed");
  saved.media.slice(0, 2).forEach(function (item) {
    assert.strictEqual(fs.existsSync(path.join(mediaDir, item.mediaKey + ".mp4")), false);
    assert.strictEqual(item.localPath, "");
    assert.strictEqual(item.downloadedAt, "");
    assert.strictEqual(item.status, "deferred");
    assert.strictEqual(item.error, "");
    assert.ok(item.downloadUrl);
  });
  saved.media.slice(2).forEach(function (item) {
    assert.ok(item.localPath);
    assert.ok(fs.existsSync(path.join(mediaDir, item.mediaKey + ".mp4")));
  });
  assert.strictEqual((await search(["video"], { mediaDownloaded: "no" })).total, 1);
  assert.strictEqual((await remove("mixed")).status, 200);
  assert.strictEqual((await remove("plain")).status, 200);
  assert.strictEqual((await remove("missing")).status, 404);

  // Missing files clear stale metadata; invalid paths cannot remove other files.
  var missing = media("missing", "video", 31000, true);
  fs.unlinkSync(path.join(mediaDir, "missing.mp4"));
  db.get("tweets").push(tweet("stale", [missing])).write();
  assert.strictEqual((await remove("stale")).status, 200);
  assert.strictEqual(persisted("stale").media[0].localPath, "");
  var unsafe = media("unsafe", "video", 31000, false);
  unsafe.localPath = "/media/../db.json";
  db.get("tweets").push(tweet("unsafe", [unsafe])).write();
  assert.strictEqual((await remove("unsafe")).status, 500);
  assert.strictEqual(persisted("unsafe").media[0].localPath, unsafe.localPath);

  // A later unlink failure still persists earlier successful deletions.
  var blocked = media("blocked", "video", 31000, false);
  blocked.localPath = "/media/blocked";
  fs.mkdirSync(path.join(mediaDir, "blocked"));
  db.get("tweets").push(tweet("partial", [media("removed", "video", 31000, true), blocked])).write();
  assert.strictEqual((await remove("partial")).status, 500);
  assert.strictEqual(persisted("partial").media[0].localPath, "");
  assert.strictEqual(persisted("partial").media[1].localPath, "/media/blocked");

  // Hold a local download open to verify deletion cannot race it, then re-download.
  var releaseDownload;
  app.get("/fixture.mp4", function (req, res) {
    releaseDownload = function () { res.type("video/mp4").send("video fixture"); };
  });
  var pending = media("pending", "video", 45000, false);
  pending.downloadUrl = "http://127.0.0.1:" + server.address().port + "/fixture.mp4";
  db.get("tweets").push(tweet("pending", [pending])).write();
  for (var attempt = 0; attempt < 2; attempt += 1) {
    releaseDownload = null;
    assert.strictEqual((await request("POST", "/tweets/pending/media/download", { forceLong: true })).status, 200);
    assert.strictEqual((await remove("pending")).status, 409);
    for (var i = 0; !releaseDownload && i < 100; i += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    assert.ok(releaseDownload, "local download started");
    releaseDownload();
    var progress;
    for (i = 0; i < 100; i += 1) {
      progress = (await request("GET", "/tweets/pending/media/progress")).body.data.progress;
      if (progress.status === "completed") { break; }
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    assert.strictEqual(progress.status, "completed");
    assert.ok(persisted("pending").media[0].localPath);
    assert.strictEqual((await remove("pending")).status, 200);
    assert.strictEqual((await request("GET", "/tweets/pending/media/progress")).body.data.progress, null);
  }
  console.log("PASS: media filters, pagination, long-video deletion, persistence, failure recovery, download conflict and re-download");
}

run().then(function () {
  server.close();
  cleanup(root);
}).catch(function (err) {
  console.error(err);
  if (server) { server.close(); }
  cleanup(root);
  process.exitCode = 1;
});
