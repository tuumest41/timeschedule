/* 計画と実行 — 1日のタイムスケジュール記録アプリ（第1段階） */
(() => {
  'use strict';

  // ===== 定数 =====
  const SNAP = 5;              // 5分単位
  const DAY_MIN = 24 * 60;     // 1440分
  const TOP_PAD = 12;          // .timeline の上余白（style.css と一致）
  const TAP_MOVE_PX = 10;      // これ以上指が動いたらスクロールとみなす
  const TAP_MAX_MS = 600;      // これ以上長く押したらタップとみなさない
  const KEY = 'ts:';           // localStorage のキーの頭

  const DEFAULT_CATEGORIES = [
    { id: 'sleep',    name: '睡眠',   color: '#4b4fb8' },
    { id: 'work',     name: '仕事',   color: '#2f6fec' },
    { id: 'meeting',  name: '会議',   color: '#9146c9' },
    { id: 'meal',     name: '食事',   color: '#e07b00' },
    { id: 'exercise', name: '運動',   color: '#23944f' },
    { id: 'move',     name: '移動',   color: '#0a8f9e' },
    { id: 'rest',     name: '休憩',   color: '#d9468d' },
    { id: 'other',    name: 'その他', color: '#737b8c' },
  ];
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  const KIND_LABEL = { plan: '計画', actual: '実行' };

  // ===== 要素 =====
  const $ = (id) => document.getElementById(id);
  const el = {
    scroller: $('scroller'), timeline: $('timeline'), timeCol: $('timeCol'),
    lanes: { plan: $('lane-plan'), actual: $('lane-actual') },
    nowLine: $('nowLine'), dateLabel: $('dateLabel'),
    prev: $('prevDay'), next: $('nextDay'), today: $('todayBtn'),
    hint: $('selectHint'), hintText: $('selectHintText'), hintCancel: $('selectCancel'),
    startBtn: $('startNowBtn'), stopBtn: $('stopBtn'), runningInfo: $('runningInfo'),
    backdrop: $('sheetBackdrop'), sheet: $('sheet'), sheetBody: $('sheetBody'),
    toast: $('toast'),
  };
  const HOUR_PX = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 76;
  const PPM = HOUR_PX / 60;    // 1分あたりのピクセル

  // ===== 保存（localStorage） =====
  const store = {
    get(k, def) {
      try {
        const v = localStorage.getItem(KEY + k);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; }
      catch (e) { toast('保存できませんでした（空き容量不足の可能性があります）'); return false; }
    },
    remove(k) { try { localStorage.removeItem(KEY + k); } catch (e) { /* 無視 */ } },
  };

  function loadDay(date) {
    const d = store.get('day:' + date, null);
    return {
      plan: d && Array.isArray(d.plan) ? d.plan : [],
      actual: d && Array.isArray(d.actual) ? d.actual : [],
    };
  }
  function saveDay(date, day) {
    if (!day.plan.length && !day.actual.length) store.remove('day:' + date);
    else store.set('day:' + date, day);
  }

  function loadCategories() {
    const c = store.get('categories', null);
    if (Array.isArray(c) && c.length) return c;
    store.set('categories', DEFAULT_CATEGORIES);
    return DEFAULT_CATEGORIES.slice();
  }

  // ===== 日付・時刻の道具 =====
  const pad2 = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayKey = () => dateKey(new Date());
  function parseKey(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(key, n) { const d = parseKey(key); d.setDate(d.getDate() + n); return dateKey(d); }
  function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
  const snap = (min) => Math.round(min / SNAP) * SNAP;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (min) => `${Math.floor(min / 60)}:${pad2(min % 60)}`;
  function fmtDur(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return `${m}分`;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ===== 状態 =====
  let categories = loadCategories();
  let curDate = todayKey();
  let lastToday = curDate;
  let day = loadDay(curDate);
  let selection = null;        // 範囲選択中 { kind, start }
  let pendingReload = false;   // シートを閉じたら再読み込み（アプリ更新時）

  const catById = (id) => categories.find((c) => c.id === id) || categories.find((c) => c.id === 'other') || categories[0];

  // 記録中（「今から開始」）のブロック
  function getRunning() {
    const r = store.get('running', null);
    if (!r) return null;
    const d = r.date === curDate ? day : loadDay(r.date);
    const block = d.actual.find((b) => b.id === r.id);
    if (!block || block.end != null) { store.remove('running'); return null; }
    return { date: r.date, block };
  }
  // 記録中ブロックの「今の終わり位置」
  function runningEnd(date, block) {
    const t = todayKey();
    if (date < t) return DAY_MIN;
    return clamp(Math.ceil(nowMin() / SNAP) * SNAP, block.start + SNAP, DAY_MIN);
  }
  const blockEnd = (date, b) => (b.end == null ? runningEnd(date, b) : b.end);

  // ===== 描画 =====
  function buildTimeLabels() {
    const frag = document.createDocumentFragment();
    for (let h = 0; h <= 24; h++) {
      const s = document.createElement('div');
      s.className = 'time-label';
      s.style.top = h * HOUR_PX + 'px';
      s.textContent = `${h}:00`;
      frag.appendChild(s);
    }
    el.timeCol.appendChild(frag);
  }

  function renderHeader() {
    const d = parseKey(curDate);
    const isToday = curDate === todayKey();
    el.dateLabel.innerHTML =
      `<small style="font-weight:400;font-size:12px;opacity:.75">${d.getFullYear()}年</small> ` +
      `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
    el.today.textContent = isToday ? '今日を表示中' : '今日へ';
    el.today.disabled = isToday;
    el.today.style.opacity = isToday ? '0.6' : '1';
  }

  function renderBlocks() {
    for (const kind of ['plan', 'actual']) {
      const lane = el.lanes[kind];
      lane.querySelectorAll('.block').forEach((n) => n.remove());
      const list = day[kind].slice().sort((a, b) => a.start - b.start);
      for (const b of list) lane.appendChild(makeBlockEl(kind, b));
    }
  }

  function makeBlockEl(kind, b) {
    const cat = catById(b.cat);
    const end = blockEnd(curDate, b);
    const h = Math.max((end - b.start) * PPM, 8);
    const n = document.createElement('div');
    n.className = 'block' + (h < 34 ? ' is-small' : '') + (b.end == null ? ' is-running' : '');
    n.dataset.id = b.id;
    n.dataset.kind = kind;
    n.style.top = b.start * PPM + 'px';
    n.style.height = h - 1 + 'px';
    n.style.backgroundColor = cat.color;
    const title = b.title || cat.name;
    const timeText = b.end == null ? `${fmt(b.start)}〜 記録中` : `${fmt(b.start)}–${fmt(b.end)}`;
    n.innerHTML = `<div class="block-title">${esc(title)}</div><div class="block-time">${timeText}</div>`;
    n.setAttribute('aria-label', `${KIND_LABEL[kind]}：${title} ${timeText}`);
    return n;
  }

  function renderSelection() {
    for (const kind of ['plan', 'actual']) {
      el.lanes[kind].querySelectorAll('.sel-start, .sel-preview').forEach((n) => n.remove());
    }
    if (!selection) { el.hint.hidden = true; return; }
    const lane = el.lanes[selection.kind];
    if (selection.end != null) {
      const p = document.createElement('div');
      p.className = 'sel-preview';
      p.style.top = selection.start * PPM + 'px';
      p.style.height = (selection.end - selection.start) * PPM + 'px';
      lane.appendChild(p);
      el.hint.hidden = true;
    } else {
      const m = document.createElement('div');
      m.className = 'sel-start';
      m.style.top = selection.start * PPM + 'px';
      m.innerHTML = `<span>${fmt(selection.start)} 開始</span>`;
      lane.appendChild(m);
      el.hintText.textContent = `${KIND_LABEL[selection.kind]}：終了位置をタップ`;
      el.hint.hidden = false;
    }
  }

  function renderNow() {
    const t = todayKey();
    // 日付が変わったら、「今日」を見ていた場合は新しい今日へ切り替える
    if (t !== lastToday) {
      const wasToday = curDate === lastToday;
      lastToday = t;
      if (wasToday && el.sheet.hidden && !selection) { goDate(t, true); return; }
    }
    if (curDate === t) {
      el.nowLine.hidden = false;
      el.nowLine.style.top = TOP_PAD + nowMin() * PPM + 'px';
    } else {
      el.nowLine.hidden = true;
    }
    renderRunningInfo();
  }

  function renderRunningInfo() {
    const r = getRunning();
    el.stopBtn.hidden = !r;
    el.startBtn.textContent = r ? '▶ 次を開始' : '▶ 今から開始';
    if (!r) { el.runningInfo.hidden = true; return; }
    const cat = catById(r.block.cat);
    const end = runningEnd(r.date, r.block);
    const dayNote = r.date === todayKey() ? '' : `（${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8))}）`;
    el.runningInfo.innerHTML =
      `記録中：<b>${esc(r.block.title || cat.name)}</b> ${dayNote}${fmt(r.block.start)}〜（${fmtDur(end - r.block.start)}）`;
    el.runningInfo.hidden = false;
  }

  function render() {
    renderHeader();
    renderBlocks();
    renderSelection();
    renderNow();
  }

  function scrollToNow(smooth) {
    const y = TOP_PAD + nowMin() * PPM - el.scroller.clientHeight / 3;
    el.scroller.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
  }

  function goDate(key, forceScroll) {
    cancelSelection();
    curDate = key;
    day = loadDay(curDate);
    render();
    if (key === todayKey() && forceScroll) scrollToNow(false);
  }

  // ===== タップ判定（スクロールと区別する） =====
  let lastScrollAt = 0;
  el.scroller.addEventListener('scroll', () => { lastScrollAt = performance.now(); }, { passive: true });

  function onTap(target, handler) {
    let st = null;
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // スクロールの慣性を止めるためのタッチは無視する
      if (performance.now() - lastScrollAt < 120) { st = null; return; }
      st = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      const b = e.target.closest('.block');
      if (b) { b.classList.add('is-pressed'); st.pressed = b; }
    });
    const clear = () => { if (st && st.pressed) st.pressed.classList.remove('is-pressed'); st = null; };
    target.addEventListener('pointermove', (e) => {
      if (st && st.id === e.pointerId &&
        (Math.abs(e.clientX - st.x) > TAP_MOVE_PX || Math.abs(e.clientY - st.y) > TAP_MOVE_PX)) clear();
    });
    target.addEventListener('pointercancel', clear);
    target.addEventListener('pointerleave', clear);
    target.addEventListener('pointerup', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const ok = performance.now() - st.t <= TAP_MAX_MS && performance.now() - lastScrollAt > 80;
      clear();
      if (ok) handler(e);
    });
  }

  function minuteAt(kind, clientY) {
    const rect = el.lanes[kind].getBoundingClientRect();
    return clamp(snap((clientY - rect.top) / PPM), 0, DAY_MIN);
  }

  function onLaneTap(kind, e) {
    const m = minuteAt(kind, e.clientY);

    if (selection && selection.end == null) {
      if (selection.kind !== kind) {           // 別の列をタップ → そちらで選び直し
        selection = { kind, start: Math.min(m, DAY_MIN - SNAP) };
        renderSelection();
        return;
      }
      let a = selection.start, b = m;
      if (b === a) b = a + 30;                  // 同じ場所をもう一度 → 30分
      if (b < a) [a, b] = [b, a];
      a = clamp(a, 0, DAY_MIN - SNAP);
      b = clamp(b, a + SNAP, DAY_MIN);
      selection = { kind, start: a, end: b };
      renderSelection();
      openBlockSheet({ mode: 'new', kind, block: { start: a, end: b, title: '', cat: null, memo: '' } });
      return;
    }

    const blockEl = e.target.closest('.block');
    if (blockEl) {
      const b = day[kind].find((x) => x.id === blockEl.dataset.id);
      if (b) openBlockSheet({ mode: 'edit', kind, block: b });
      return;
    }

    selection = { kind, start: Math.min(m, DAY_MIN - SNAP) };
    renderSelection();
    if (navigator.vibrate) navigator.vibrate(10);
  }

  function cancelSelection() {
    selection = null;
    renderSelection();
  }

  // ===== ボトムシート =====
  let sheetOnClose = null;
  function openSheet(html, onClose) {
    el.sheetBody.innerHTML = html;
    el.sheet.hidden = false;
    el.backdrop.hidden = false;
    el.sheet.scrollTop = 0;
    sheetOnClose = onClose || null;
  }
  function closeSheet() {
    if (el.sheet.hidden) return;
    el.sheet.hidden = true;
    el.backdrop.hidden = true;
    el.sheetBody.innerHTML = '';
    const cb = sheetOnClose; sheetOnClose = null;
    if (cb) cb();
    if (pendingReload) location.reload();
  }
  el.backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.sheet.hidden) closeSheet(); else cancelSelection();
  });

  function timeOptions(from, to, selected) {
    let s = '';
    for (let m = from; m <= to; m += SNAP) s += `<option value="${m}"${m === selected ? ' selected' : ''}>${fmt(m)}</option>`;
    return s;
  }
  function catButtons(selectedId, big) {
    return `<div class="cat-grid${big ? ' is-big' : ''}">` + categories.map((c) =>
      `<button type="button" class="cat-btn${c.id === selectedId ? ' is-selected' : ''}" data-cat="${esc(c.id)}">` +
      `<span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('') + '</div>';
  }

  // ブロックの追加・編集
  function openBlockSheet({ mode, kind, block }) {
    const isNew = mode === 'new';
    const running = block.end == null && !isNew;
    const endSel = running ? -1 : block.end;
    const heading = isNew ? `${KIND_LABEL[kind]}を追加` : `${KIND_LABEL[kind]}を編集`;
    let selectedCat = block.cat;

    openSheet(`
      <h2>${heading}</h2>
      <p class="sub" id="bsDur"></p>
      <div class="field">
        <label for="bsTitle">内容</label>
        <input type="text" id="bsTitle" maxlength="60" placeholder="例：資料作成（空欄ならカテゴリ名を表示）" value="${esc(block.title || '')}" enterkeyhint="done">
      </div>
      <div class="field">
        <span class="field-label">カテゴリ</span>
        ${catButtons(selectedCat, false)}
      </div>
      <div class="field">
        <span class="field-label">時間（5分刻み）</span>
        <div class="time-row">
          <select id="bsStart" aria-label="開始">${timeOptions(0, DAY_MIN - SNAP, block.start)}</select>
          <span class="tilde">〜</span>
          <select id="bsEnd" aria-label="終了">
            ${running ? '<option value="-1" selected>記録中</option>' : ''}
            ${timeOptions(SNAP, DAY_MIN, endSel)}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="bsMemo">メモ</label>
        <textarea id="bsMemo" maxlength="500" placeholder="メモ（任意）">${esc(block.memo || '')}</textarea>
      </div>
      <div class="sheet-actions">
        ${isNew ? '' : '<button type="button" class="btn danger" id="bsDelete">削除</button>'}
        <button type="button" class="btn" id="bsCancel">キャンセル</button>
        <button type="button" class="btn primary" id="bsSave">${isNew ? '追加' : '保存'}</button>
      </div>
    `, () => { if (isNew) cancelSelection(); });

    const q = (id) => el.sheetBody.querySelector('#' + id);
    const startSel = q('bsStart'), endSelEl = q('bsEnd'), durEl = q('bsDur');

    const updateDur = () => {
      const s = Number(startSel.value), e = Number(endSelEl.value);
      if (e === -1) durEl.textContent = `${fmt(s)}〜 記録中`;
      else if (e <= s) durEl.textContent = '⚠ 終了は開始より後にしてください';
      else durEl.textContent = `${fmt(s)}〜${fmt(e)}（${fmtDur(e - s)}）`;
      if (isNew && e > s) { selection = { kind, start: s, end: e }; renderSelection(); }
    };
    startSel.addEventListener('change', updateDur);
    endSelEl.addEventListener('change', updateDur);
    updateDur();

    el.sheetBody.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedCat = btn.dataset.cat;
        el.sheetBody.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('is-selected', b === btn));
      });
    });
    q('bsTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    q('bsCancel').addEventListener('click', closeSheet);

    q('bsSave').addEventListener('click', () => {
      const s = Number(startSel.value), e = Number(endSelEl.value);
      if (e !== -1 && e <= s) { toast('終了は開始より後にしてください'); return; }
      const values = {
        start: s,
        end: e === -1 ? null : e,
        title: q('bsTitle').value.trim(),
        cat: selectedCat || 'other',
        memo: q('bsMemo').value.trim(),
      };
      if (isNew) {
        day[kind].push({ id: uid(), ...values });
      } else {
        const target = day[kind].find((x) => x.id === block.id);
        if (target) Object.assign(target, values);
        if (running && values.end != null) store.remove('running');
      }
      saveDay(curDate, day);
      selection = null;
      closeSheet();
      render();
    });

    const del = q('bsDelete');
    if (del) {
      del.addEventListener('click', () => {
        if (!confirm('このブロックを削除しますか？')) return;
        day[kind] = day[kind].filter((x) => x.id !== block.id);
        if (running) store.remove('running');
        saveDay(curDate, day);
        closeSheet();
        render();
      });
    }
  }

  // ===== 今から開始 =====
  function openStartSheet() {
    cancelSelection();
    const r = getRunning();
    const t = todayKey();
    const start = Math.min(snap(nowMin()), DAY_MIN - SNAP);
    let sub = `${fmt(start)} から「実行」に記録します。`;
    if (r) {
      const endAt = r.date === t ? start : DAY_MIN;
      sub += `<br>記録中の「${esc(r.block.title || catById(r.block.cat).name)}」は ${fmt(endAt)} で終了します。`;
    }
    openSheet(`
      <h2>今から開始</h2>
      <p class="sub">${sub}</p>
      <div class="field">
        <label for="snTitle">内容（任意）</label>
        <input type="text" id="snTitle" maxlength="60" placeholder="空欄ならカテゴリ名を表示" enterkeyhint="done">
      </div>
      <div class="field">
        <span class="field-label">カテゴリを選ぶと開始します</span>
        ${catButtons(null, true)}
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn" id="snCancel">キャンセル</button>
      </div>
    `);
    const title = el.sheetBody.querySelector('#snTitle');
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    el.sheetBody.querySelector('#snCancel').addEventListener('click', closeSheet);
    el.sheetBody.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        startNow(btn.dataset.cat, title.value.trim());
        closeSheet();
      });
    });
  }

  // 記録中ブロックを endMin で終了する。0分になったら削除する
  function finishRunning(r, endMin) {
    const d = r.date === curDate ? day : loadDay(r.date);
    const b = d.actual.find((x) => x.id === r.block.id);
    store.remove('running');
    if (!b) return;
    if (endMin <= b.start) {
      d.actual = d.actual.filter((x) => x.id !== b.id);
      toast(`「${b.title || catById(b.cat).name}」は0分だったため削除しました`);
    } else {
      b.end = endMin;
    }
    saveDay(r.date, d);
    if (r.date === curDate) day = d;
  }

  function startNow(catId, title) {
    const t = todayKey();
    const start = Math.min(snap(nowMin()), DAY_MIN - SNAP);
    const r = getRunning();
    if (r) finishRunning(r, r.date === t ? start : DAY_MIN);

    const td = t === curDate ? day : loadDay(t);
    const block = { id: uid(), start, end: null, title, cat: catId, memo: '' };
    td.actual.push(block);
    saveDay(t, td);
    store.set('running', { date: t, id: block.id });

    if (curDate !== t) goDate(t, true);
    else { day = td; render(); scrollToNow(true); }
    toast(`${fmt(start)}〜「${title || catById(catId).name}」を開始しました`);
  }

  function stopNow() {
    const r = getRunning();
    if (!r) return;
    const name = r.block.title || catById(r.block.cat).name;
    const end = r.date === todayKey()
      ? clamp(snap(nowMin()), r.block.start + SNAP, DAY_MIN)
      : DAY_MIN;
    finishRunning(r, end);
    render();
    toast(`「${name}」を ${fmt(end)} で終了しました`);
  }

  // ===== お知らせ =====
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  // ===== イベント =====
  onTap(el.lanes.plan, (e) => onLaneTap('plan', e));
  onTap(el.lanes.actual, (e) => onLaneTap('actual', e));
  el.hintCancel.addEventListener('click', cancelSelection);
  el.prev.addEventListener('click', () => goDate(addDays(curDate, -1)));
  el.next.addEventListener('click', () => goDate(addDays(curDate, 1)));
  el.today.addEventListener('click', () => goDate(todayKey(), true));
  el.startBtn.addEventListener('click', openStartSheet);
  el.stopBtn.addEventListener('click', stopNow);

  // 現在時刻・記録中ブロックの更新（30秒ごと）
  setInterval(() => {
    renderNow();
    const r = getRunning();
    if (r && r.date === curDate) renderBlocks();
  }, 30 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const t = todayKey();
    if (t !== lastToday && curDate === lastToday && el.sheet.hidden) { lastToday = t; goDate(t, true); return; }
    day = loadDay(curDate);
    render();
  });

  // 他のタブで変更されたとき（PC向け）
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(KEY)) { categories = loadCategories(); day = loadDay(curDate); render(); }
  });

  // ===== 起動 =====
  buildTimeLabels();
  render();
  requestAnimationFrame(() => scrollToNow(false));

  // ===== Service Worker（オフライン対応・更新） =====
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    // 新しい版が有効になったら画面を読み込み直す（入力中なら閉じてから）
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      if (el.sheet.hidden) location.reload();
      else { pendingReload = true; toast('新しいバージョンがあります。入力を閉じると更新されます'); }
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
        // アプリを開き直すたびに更新を確認
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      }).catch((err) => console.warn('Service Worker の登録に失敗:', err));
    });
  }
})();
