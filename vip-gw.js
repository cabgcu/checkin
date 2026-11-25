// vip-gw.js: replaces the direct Supabase client for the VIP check-in pages. Every call goes to the vip-gateway Edge Function.
(function () {
  var GW = 'https://csutspaxezmjbqynpprt.supabase.co/functions/v1/vip-gateway';
  var KEY = 'sb_publishable_i76vLYFHz3RJXDsV_HwBzA_5db5M9bG';
  var TK = 'vipAdminToken';
  function readTok() {
    var o = null;
    try { o = JSON.parse(sessionStorage.getItem(TK) || localStorage.getItem(TK) || 'null'); } catch (e) {}
    return o && o.exp > Date.now() ? o.t : null;
  }
  async function call(body) {
    var h = { 'Content-Type': 'application/json', apikey: KEY };
    var t = readTok(); if (t) h.Authorization = 'Bearer ' + t;
    var r = await fetch(GW, { method: 'POST', headers: h, body: JSON.stringify(body) });
    var j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, ok: r.ok, json: j };
  }
  function enc(v) { return String(v); }
  function Q(table) { this.t = table; this.op = 'select'; this.f = []; this.sel = '*'; this.ord = null; this.lim = null; this.d = null; this.ret = false; this.mode = 'many'; this.oc = null; }
  Q.prototype.select = function (c) { if (this.op === 'select') this.sel = c || '*'; else { this.ret = true; } return this; };
  Q.prototype.insert = function (d) { this.op = 'insert'; this.d = d; return this; };
  Q.prototype.update = function (d) { this.op = 'update'; this.d = d; return this; };
  Q.prototype.upsert = function (d, o) { this.op = 'upsert'; this.d = d; this.oc = o && o.onConflict || null; return this; };
  Q.prototype.delete = function () { this.op = 'delete'; return this; };
  Q.prototype.eq = function (c, v) { this.f.push(c + '=eq.' + enc(v)); return this; };
  Q.prototype.neq = function (c, v) { this.f.push(c + '=neq.' + enc(v)); return this; };
  Q.prototype.gt = function (c, v) { this.f.push(c + '=gt.' + enc(v)); return this; };
  Q.prototype.gte = function (c, v) { this.f.push(c + '=gte.' + enc(v)); return this; };
  Q.prototype.lt = function (c, v) { this.f.push(c + '=lt.' + enc(v)); return this; };
  Q.prototype.lte = function (c, v) { this.f.push(c + '=lte.' + enc(v)); return this; };
  Q.prototype.is = function (c, v) { this.f.push(c + '=is.' + (v === null ? 'null' : enc(v))); return this; };
  Q.prototype.ilike = function (c, v) { this.f.push(c + '=ilike.' + enc(v)); return this; };
  Q.prototype.in = function (c, arr) { this.f.push(c + '=in.(' + arr.map(function (x) { return '"' + enc(x).replace(/"/g, '\\"') + '"'; }).join(',') + ')'); return this; };
  Q.prototype.order = function (c, o) { this.ord = c + '.' + (o && o.ascending === false ? 'desc' : 'asc'); return this; };
  Q.prototype.limit = function (n) { this.lim = n; return this; };
  Q.prototype.single = function () { this.mode = 'single'; return this; };
  Q.prototype.maybeSingle = function () { this.mode = 'maybe'; return this; };
  Q.prototype.run = async function () {
    var qs = new URLSearchParams();
    var keepSel = this.op === 'select' || this.ret;
    if (this.op === 'select') qs.set('select', this.sel.replace(/\s+/g, ''));
    for (var i = 0; i < this.f.length; i++) { var k = this.f[i], ix = k.indexOf('='); qs.append(k.slice(0, ix), k.slice(ix + 1)); }
    if (this.ord) qs.set('order', this.ord);
    if (this.lim) qs.set('limit', String(this.lim));
    var r;
    try { r = await call({ action: 'q', table: this.t, op: this.op, query: qs.toString(), data: this.d, returning: this.ret, onConflict: this.oc }); }
    catch (e) { return { data: null, error: { message: String(e && e.message || e) } }; }
    if (!r.ok) return { data: null, error: { message: (r.json && (r.json.message || r.json.error)) || ('HTTP ' + r.status), code: r.json && r.json.code } };
    var data = r.json;
    if (!keepSel) return { data: null, error: null };
    if (this.mode === 'single') { if (!Array.isArray(data) || data.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }; return { data: data[0], error: null }; }
    if (this.mode === 'maybe') return { data: Array.isArray(data) ? (data[0] || null) : data, error: null };
    return { data: data, error: null };
  };
  Q.prototype.then = function (a, b) { return this.run().then(a, b); };
  async function rpc(fn, args) {
    args = args || {};
    if (fn === 'verify_admin_password') {
      var r = await call({ action: 'login', password: args.pass });
      if (!r.ok) return { data: null, error: { message: 'HTTP ' + r.status } };
      if (r.json && r.json.ok) { var o = JSON.stringify({ t: r.json.token, exp: Date.now() + 29 * 24 * 3600 * 1000 }); try { sessionStorage.setItem(TK, o); } catch (e) {} return { data: true, error: null }; }
      return { data: false, error: null };
    }
    if (fn === 'set_admin_password') {
      var r2 = await call({ action: 'setAdminPassword', currentPassword: args.current_pass, newPassword: args.new_pass });
      if (!r2.ok) return { data: null, error: { message: 'HTTP ' + r2.status } };
      return { data: !!(r2.json && r2.json.ok), error: null };
    }
    var r3 = await call({ action: 'rpc', fn: fn, args: args });
    if (!r3.ok) return { data: null, error: { message: (r3.json && r3.json.error) || ('HTTP ' + r3.status) } };
    return { data: r3.json.data, error: r3.json.error };
  }
  var storage = { from: function (bucket) { return {
    upload: async function (path, file, opts) {
      var u = await call({ action: 'uploadUrl', path: path });
      if (!u.ok || !u.json || !u.json.signedUrl) return { data: null, error: { message: (u.json && u.json.error) || 'upload not allowed' } };
      var fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', file);
      var pr = await fetch(u.json.signedUrl, { method: 'PUT', body: fd, headers: { 'x-upsert': 'true' } });
      if (!pr.ok) return { data: null, error: { message: 'upload failed (' + pr.status + ')' } };
      return { data: { path: path }, error: null };
    },
    getPublicUrl: function (path) { return { data: { publicUrl: 'https://csutspaxezmjbqynpprt.supabase.co/storage/v1/object/public/vip-banners/' + path } }; },
    remove: async function (paths) { var r = await call({ action: 'storageRemove', paths: paths }); return { data: null, error: r.ok ? null : { message: 'HTTP ' + r.status } }; }
  }; } };
  // realtime replacement: poll a cheap change hash while the tab is visible
  var polls = [];
  function channel() {
    var ch = { cbs: [], timer: null, last: null,
      on: function (type, cfg, cb) { this.cbs.push(cb); return this; },
      subscribe: function () {
        var me = this;
        me.timer = setInterval(async function () {
          if (document.visibilityState !== 'visible' || !readTok()) return;
          var ev = ''; try { ev = localStorage.getItem('activeEventId') || ''; } catch (e) {}
          if (!ev) return;
          var r = await call({ action: 'changeToken', eventId: ev });
          if (!r.ok || !r.json) return;
          var sig = r.json.n + ':' + r.json.h;
          if (me.last !== null && me.last !== sig) me.cbs.forEach(function (c) { try { c(); } catch (e) {} });
          me.last = sig;
        }, 20000);
        return me;
      } };
    return ch;
  }
  function removeChannel(ch) { if (ch && ch.timer) clearInterval(ch.timer); }
  window.vipGw = {
    client: { from: function (t) { return new Q(t); }, rpc: rpc, storage: storage, channel: channel, removeChannel: removeChannel },
    hasToken: function () { return !!readTok(); },
    persist: function (keep) { try { if (keep) localStorage.setItem(TK, sessionStorage.getItem(TK)); else localStorage.removeItem(TK); } catch (e) {} },
    clear: function () { try { sessionStorage.removeItem(TK); localStorage.removeItem(TK); } catch (e) {} },
    // Brevo send via the gateway (key stays on the server). Returns a fetch-like Response.
    send: async function (payload) {
      var r = await call({ action: 'sendEmail', payload: payload });
      var b = (r.json && r.json.body) || {};
      var ok = !!(r.ok && r.json && r.json.ok);
      return { ok: ok, status: (r.json && r.json.status) || r.status, json: async function () { return b; } };
    }
  };
})();
