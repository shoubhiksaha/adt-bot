// The script ADT Bot runs inside a web page to read and use it: on macOS through the browser's
// "execute javascript" scripting command (70-mac-control.cjs), on Linux over the browser's
// debugging connection (linux-browser.cjs). Same page script, so pages behave the same everywhere.

/**
 * Runs inside the page: lists what can be clicked or typed into (giving each an id that stays the
 * same while the page lives), clicks, types, scrolls, reads the text. Called with one JSON object.
 */
const PAGE_FN = `function (req) {
  var D = document, W = window;
  var reg = W.__adtEls || (W.__adtEls = { next: 1, byId: {} });
  function clean(s, n) { s = String(s == null ? '' : s).replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; }
  function box(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var st = W.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return null;
    return r;
  }
  function editable(el) { return el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type || ''); }
  function role(el) {
    var r = el.getAttribute('role');
    if (r) return r === 'textbox' || r === 'searchbox' ? 'text field' : r;
    var t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'pop-up menu';
    if (t === 'TEXTAREA' || el.isContentEditable) return 'text area';
    if (t === 'INPUT') {
      var ty = (el.type || 'text').toLowerCase();
      if (/^(submit|button|reset|image)$/.test(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'search') return 'search field';
      if (ty === 'password') return 'password field';
      return 'text field';
    }
    return 'button';
  }
  function label(el) {
    var l = el.getAttribute('aria-label') || '';
    var by = el.getAttribute('aria-labelledby');
    if (!l && by) l = by.split(/\\s+/).map(function (id) { var t = D.getElementById(id); return t ? t.textContent : ''; }).join(' ');
    if (!l && el.labels && el.labels.length) l = el.labels[0].textContent;
    if (!l && !editable(el) && el.tagName !== 'SELECT') l = el.innerText || el.textContent || '';
    if (!l) l = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('data-placeholder') || '';
    if (!l && el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) l = el.value;
    if (!l && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) l = el.getAttribute('name') || '';
    if (!l) { var img = el.querySelector && el.querySelector('img[alt],svg[aria-label]'); if (img) l = img.getAttribute('alt') || img.getAttribute('aria-label'); }
    return clean(l, 120);
  }
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=treeitem],[role=gridcell][tabindex],[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]';
  function collect(root, out) {
    var found = root.querySelectorAll(SEL);
    for (var i = 0; i < found.length; i++) out.push(found[i]);
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) collect(all[j].shadowRoot, out);
    return out;
  }
  function idOf(el) {
    if (!el.__adtId) { el.__adtId = reg.next++; reg.byId[el.__adtId] = el; }
    return el.__adtId;
  }
  function find(id) {
    var el = reg.byId[id];
    if (!el || !el.isConnected) throw new Error('ADT_STALE');
    return el;
  }
  function snapshot() {
    var words = clean(req.query || '', 200).toLowerCase().split(' ').filter(Boolean);
    var max = Math.max(10, Math.min(400, req.max || 150));
    var vw = W.innerWidth, vh = W.innerHeight;
    var els = collect(D, []);
    var out = [], matched = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest('[aria-hidden=true],[inert]')) continue;
      var r = box(el);
      if (!r) continue;
      var e = { id: 0, role: role(el), label: label(el) };
      if (editable(el)) { e.input = true; e.value = clean(el.isContentEditable ? el.innerText : (el.type === 'password' ? (el.value ? '\\u2022\\u2022\\u2022' : '') : el.value), 300); }
      else if (el.tagName === 'SELECT') e.value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '', 80);
      if (!e.label && !e.input && e.role !== 'checkbox' && el.tagName !== 'SELECT') continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true;
      if (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') e.selected = true;
      if (D.activeElement === el) e.focused = true;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) e.offscreen = true;
      if (el.tagName === 'A' && el.href && !/^javascript:/i.test(el.getAttribute('href') || '')) e.href = clean(el.href, 200);
      if (words.length) { var hay = (e.role + ' ' + e.label + ' ' + (e.value || '') + ' ' + (e.href || '')).toLowerCase(); if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) continue; }
      matched++;
      if (out.length >= max) continue;
      e.id = idOf(el);
      out.push(e);
    }
    var result = { url: location.href, title: clean(D.title, 200), elements: out, matched: matched, scroll: { y: Math.round(W.scrollY), height: Math.round(D.documentElement.scrollHeight), view: vh } };
    if (req.content) {
      var main = D.querySelector('main,[role=main],article') || D.body;
      var text = clean(main ? main.innerText : '', 1e6);
      var from = Math.max(0, req.offset || 0);
      result.text = text.slice(from, from + (req.chars || 12000));
      result.textLength = text.length;
    }
    return result;
  }
  function pointer(el, type) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, composed: true, view: W, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: type.indexOf('down') >= 0 ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(type.indexOf('pointer') === 0 && W.PointerEvent ? new PointerEvent(type, o) : new MouseEvent(type, o));
  }
  function click(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    pointer(el, 'pointerdown'); pointer(el, 'mousedown');
    if (el.focus) el.focus({ preventScroll: true });
    pointer(el, 'pointerup'); pointer(el, 'mouseup');
    el.click();
    return { ok: true, label: label(el), role: role(el) };
  }
  function valueOf(el) { return el.isContentEditable ? el.innerText : el.value; }
  function key(el, k) {
    var o = { key: k, code: k, keyCode: k === 'Enter' ? 13 : 0, which: k === 'Enter' ? 13 : 0, bubbles: true, cancelable: true, composed: true };
    var go = el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    return go;
  }
  function type(el) {
    var text = String(req.text || '');
    if (el.tagName === 'SELECT') {
      var want = clean(text, 200).toLowerCase(), hit = -1;
      for (var i = 0; i < el.options.length; i++) { var t = clean(el.options[i].text, 200).toLowerCase(); if (t === want || el.options[i].value.toLowerCase() === want) { hit = i; break; } if (hit < 0 && t.indexOf(want) >= 0) hit = i; }
      if (hit < 0) throw new Error('No option "' + text + '"; the options are: ' + Array.prototype.map.call(el.options, function (o) { return o.text; }).slice(0, 30).join(', '));
      el.selectedIndex = hit;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.options[hit].text };
    }
    if (!editable(el)) throw new Error('ADT_NOT_EDITABLE');
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    var before = valueOf(el);
    if (el.isContentEditable) {
      var range = D.createRange();
      range.selectNodeContents(el);
      if (req.append) range.collapse(false);
      var sel = W.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else if (req.append) { el.setSelectionRange && el.setSelectionRange(el.value.length, el.value.length); }
    else if (el.select) el.select();
    var expected = req.append ? before + text : text;
    // As if typed: editors (React, Lexical, Draft, ProseMirror) see a normal insert.
    var ok = text ? D.execCommand('insertText', false, text) : D.execCommand('delete');
    if (!ok || clean(valueOf(el), 1e6) !== clean(expected, 1e6)) {
      if (el.isContentEditable) { el.textContent = expected; }
      else {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, expected);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    var out = { ok: true, value: clean(el.type === 'password' ? '' : valueOf(el), 300) };
    if (req.submit) {
      var go = key(el, 'Enter');
      var form = el.form || el.closest('form');
      if (go && form && valueOf(el) !== '') { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
      out.submitted = true;
    }
    return out;
  }
  try {
    var r;
    // An id from a read of another page (the user switched tabs, the page navigated) is refused.
    if (req.expect && (req.op === 'click' || req.op === 'type') && location.href.split('#')[0] !== String(req.expect).split('#')[0]) throw new Error('ADT_MOVED');
    if (req.op === 'read') r = snapshot();
    else if (req.op === 'click') r = click(find(req.id));
    else if (req.op === 'type') r = type(find(req.id));
    else if (req.op === 'scroll') { if (req.id) find(req.id).scrollIntoView({ block: 'center' }); else W.scrollBy(0, req.dy || W.innerHeight * 0.8); r = { ok: true, y: Math.round(W.scrollY) }; }
    else if (req.op === 'back') { history.back(); r = { ok: true }; }
    else if (req.op === 'forward') { history.forward(); r = { ok: true }; }
    else if (req.op === 'reload') { location.reload(); r = { ok: true }; }
    else throw new Error('unknown operation');
    return JSON.stringify({ result: r });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
}`;

/** The page script call for one request: the request is JSON, so it can only ever be data. */
function pageScript(req) {
  return `(${PAGE_FN})(${JSON.stringify(req).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")})`;
}

/** What the page script answered, or the error it reported, in words for the bot. */
function pageResult(name, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} returned nothing from the page (it may still be loading, or it's a built-in page like the new tab page). Try again in a moment.`);
  }
  if (parsed.error === "ADT_STALE") throw Object.assign(new Error("That element is gone (the page changed). Read the page again (action read)."), { code: "stale" });
  if (parsed.error === "ADT_NOT_EDITABLE") throw new Error("That element isn't a text field. Read the page again and pick a field.");
  if (parsed.error === "ADT_MOVED") throw Object.assign(new Error("The page in front isn't the one that was read (another tab, or it moved on). Nothing was done: read the page again (action read)."), { code: "stale" });
  if (parsed.error) throw new Error(`The page refused: ${parsed.error}`);
  return parsed.result;
}

module.exports = { PAGE_FN, pageScript, pageResult };
