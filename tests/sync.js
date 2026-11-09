"use strict";

var assert = require("assert");
var axios = require("axios");
var low = require("lowdb");
var Memory = require("lowdb/adapters/Memory");
var router = require("../routes/api");
var db = low(new Memory());
var relikedId = "2100811705735590174";
var date = "2026-09-18T04:58:36.000Z";
var syncRoute = router.stack.find(function (layer) {
  return layer.route && layer.route.path === "/sync" && layer.route.methods.post;
}).route;

function resetDb() {
  db.setState({
    settings: { userId: "1", syncPageSize: 5 },
    sync: {},
    tweets: [
      { id: "1003", sortOrder: 30, localCreatedAt: date },
      { id: "1002", sortOrder: 29, localCreatedAt: date },
      { id: relikedId, sortOrder: 28, localCreatedAt: date, tags: ["kept"], note: "keep me" }
    ]
  }).write();
}

// Stub X's transport and dispatch the Express route in-process.
function mockPages(pages) {
  var requested = [];
  axios.defaults.adapter = function (config) {
    assert.strictEqual(config.url, "https://api.x.com/2/users/1/liked_tweets");
    var token = config.params.pagination_token || "";
    var page = pages[token];
    requested.push(token);
    assert.ok(page, "Unexpected pagination token: " + token);
    if (page.rateLimited) {
      var err = new Error("Rate limited");
      err.response = { status: 429, data: {}, headers: {} };
      return Promise.reject(err);
    }
    return Promise.resolve({
      status: 200,
      headers: {},
      data: {
        data: page.ids.map(function (id) {
          return { id: id, text: id, created_at: date };
        }),
        meta: { next_token: page.next, result_count: page.ids.length }
      }
    });
  };
  return requested;
}

function sync(mode) {
  return new Promise(function (resolve) {
    var req = { method: "POST", app: { locals: { db: db } }, body: { mode: mode } };
    var res = {
      statusCode: 200,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (body) {
        resolve({ status: this.statusCode, body: body });
      }
    };
    syncRoute.dispatch(req, res, function (err) {
      resolve({ status: err ? err.statusCode || 500 : 404, error: err });
    });
  });
}

async function run() {
  // The isolated repeat cannot hide subsequent new posts. The old leading pair spans pages.
  resetDb();
  var requested = mockPages({
    "": { ids: ["1006", relikedId, "1005", "1004", "1003"], next: "next" },
    next: { ids: ["1002", "1001"], next: "unexpected" }
  });
  var result = await sync("incremental");
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(requested, ["", "next"]);
  assert.strictEqual(result.body.data.added, 3);
  assert.strictEqual(result.body.data.updated, 1);
  assert.strictEqual(result.body.data.stoppedByDuplicate, true);
  var tweets = db.get("tweets").value();
  assert.deepStrictEqual(tweets.map(function (tweet) { return tweet.id; }).sort(),
    ["1002", "1003", "1004", "1005", "1006", relikedId]);
  var reliked = db.get("tweets").find({ id: relikedId }).value();
  assert.deepStrictEqual(reliked.tags, ["kept"]);
  assert.strictEqual(reliked.note, "keep me");
  assert.strictEqual(reliked.localCreatedAt, date);
  assert.ok(reliked.sortOrder > 30);
  assert.strictEqual(db.get("tweets").find({ id: "1003" }).value().sortOrder, 30);

  // Resuming after a rate limit must use the original boundary, not posts added during the run.
  resetDb();
  var pages = {
    "": { ids: ["1006", "1005", "1004", "1003"], next: "next" },
    next: { rateLimited: true }
  };
  requested = mockPages(pages);
  result = await sync("incremental");
  assert.strictEqual(result.status, 429);
  pages.next = { ids: ["1002", "1001"], next: "unexpected" };
  result = await sync("resume");
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(requested, ["", "next", "next"]);
  assert.strictEqual(result.body.data.added, 3);
  assert.strictEqual(result.body.data.updated, 0);
  assert.strictEqual(result.body.data.stoppedByDuplicate, true);
}

process.env.X_ACCESS_TOKEN = "sync-fixture-token";
run().then(function () {
  console.log("sync tests passed");
}, function (err) {
  console.error(err);
  process.exitCode = 1;
});
