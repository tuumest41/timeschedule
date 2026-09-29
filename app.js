/* 計画と実行 — 1日のタイムスケジュール記録アプリ */
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
    summaryBtn: $('summaryBtn'), menuBtn: $('menuBtn'), importFile: $('importFile'),
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

  // カテゴリは ID で参照する。削除は「deleted」の印を付けるだけなので、既存ブロックは元の名前・色のまま表示できる
  const UNKNOWN_CAT = { id: '', name: '未分類', color: '#9aa0ab' };
  const catById = (id) => categories.find((c) => c.id === id) || UNKNOWN_CAT;
  const activeCats = () => categories.filter((c) => !c.deleted);
  const defaultCatId = () => {
    const act = activeCats();
    return (act.find((c) => c.id === 'other') || act[0] || UNKNOWN_CAT).id;
  };

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
    el.today.disabled = isToday;
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
    // 削除済みカテゴリは選択肢に出さない（ただし編集中のブロックが使っているものは表示）
    const list = categories.filter((c) => !c.deleted || c.id === selectedId);
    return `<div class="cat-grid${big ? ' is-big' : ''}">` + list.map((c) =>
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
        cat: selectedCat || defaultCatId(),
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

  // ===== 集計 =====
  const fmtHM = (min) => `${Math.floor(min / 60)}:${pad2(min % 60)}`;
  function fmtDiff(min) {
    if (min === 0) return '±0:00';
    return (min > 0 ? '+' : '−') + fmtHM(Math.abs(min));
  }

  function openSummary() {
    cancelSelection();
    const totals = new Map();   // catId → { plan, actual }
    const add = (catId, kind, min) => {
      const key = categories.some((c) => c.id === catId) ? catId : '';
      if (!totals.has(key)) totals.set(key, { plan: 0, actual: 0 });
      totals.get(key)[kind] += min;
    };
    let hasRunning = false;
    for (const kind of ['plan', 'actual']) {
      for (const b of day[kind]) {
        if (b.end == null) hasRunning = true;
        add(b.cat, kind, Math.max(0, blockEnd(curDate, b) - b.start));
      }
    }
    // カテゴリ設定の並び順で表示（未分類は最後）
    const order = categories.map((c) => c.id).concat(['']);
    const rows = [...totals.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const max = Math.max(1, ...rows.map(([, v]) => Math.max(v.plan, v.actual)));
    let sumPlan = 0, sumActual = 0;

    const d = parseKey(curDate);
    let body;
    if (!rows.length) {
      body = '<p class="empty-note">この日の記録はまだありません。</p>';
    } else {
      const tr = rows.map(([id, v]) => {
        sumPlan += v.plan; sumActual += v.actual;
        const c = catById(id);
        const diff = v.actual - v.plan;
        return `<tr>
          <td><div class="cat-cell"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}${c.deleted ? '<span class="muted">（削除済み）</span>' : ''}</div>
            <div class="sum-bars">
              <div class="sum-bar plan" style="width:${(v.plan / max) * 100}%;background:${esc(c.color)}"></div>
              <div class="sum-bar" style="width:${(v.actual / max) * 100}%;background:${esc(c.color)}"></div>
            </div></td>
          <td>${v.plan ? fmtHM(v.plan) : '<span class="muted">–</span>'}</td>
          <td>${v.actual ? fmtHM(v.actual) : '<span class="muted">–</span>'}</td>
          <td class="${diff > 0 ? 'diff-over' : diff < 0 ? 'diff-under' : 'muted'}">${fmtDiff(diff)}</td>
        </tr>`;
      }).join('');
      const sumDiff = sumActual - sumPlan;
      body = `
        <table class="sum-table">
          <thead><tr><th>カテゴリ</th><th>計画</th><th>実行</th><th>差</th></tr></thead>
          <tbody>${tr}</tbody>
          <tfoot><tr><td>合計</td><td>${fmtHM(sumPlan)}</td><td>${fmtHM(sumActual)}</td>
            <td class="${sumDiff > 0 ? 'diff-over' : sumDiff < 0 ? 'diff-under' : ''}">${fmtDiff(sumDiff)}</td></tr></tfoot>
        </table>
        <p class="note">差 ＝ 実行 − 計画（＋は計画より多い、−は少ない）。バーは上が計画（薄い色）、下が実行です。${hasRunning ? '<br>記録中のブロックは現在時刻までで計算しています。' : ''}</p>`;
    }
    openSheet(`
      <h2>集計</h2>
      <p class="sub">${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]}) のカテゴリ別時間</p>
      ${body}
      <div class="sheet-actions"><button type="button" class="btn" id="sumClose">閉じる</button></div>
    `);
    el.sheetBody.querySelector('#sumClose').addEventListener('click', closeSheet);
  }

  // ===== 設定メニュー =====
  function menuItem(id, icon, label, desc) {
    return `<button type="button" class="menu-item" id="${id}"><span class="icon">${icon}</span>` +
      `<span class="label">${label}${desc ? `<span class="desc">${desc}</span>` : ''}</span><span class="chev">›</span></button>`;
  }

  function openMenu() {
    cancelSelection();
    const d = parseKey(curDate);
    const last = store.get('lastBackup', null);
    const lastText = last ? `前回：${new Date(last).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'まだ書き出していません';
    openSheet(`
      <h2>設定</h2>
      <h3>表示中の日（${d.getMonth() + 1}月${d.getDate()}日）</h3>
      <div class="menu-list">
        ${menuItem('mCopy', '📋', '前日の計画をコピー', '前日の「計画」をこの日の計画に写します')}
        ${menuItem('mCsv', '📄', 'この日のCSVを書き出し', 'Excelなどで開けるファイル')}
      </div>
      <h3>カテゴリ</h3>
      <div class="menu-list">
        ${menuItem('mCats', '🎨', 'カテゴリの追加・編集', '名前・色の変更、追加、削除')}
      </div>
      <h3>バックアップ（全データ）</h3>
      <div class="menu-list">
        ${menuItem('mExport', '⬆️', 'バックアップを書き出し（JSON）', lastText)}
        ${menuItem('mImport', '⬇️', 'バックアップから読み込み', '書き出したJSONファイルを選びます')}
      </div>
      <p class="version-note" id="versionNote">バージョン：確認中…</p>
      <div class="sheet-actions"><button type="button" class="btn" id="mClose">閉じる</button></div>
    `);
    const q = (id) => el.sheetBody.querySelector('#' + id);
    q('mCopy').addEventListener('click', openCopyPrev);
    q('mCsv').addEventListener('click', exportCSV);
    q('mCats').addEventListener('click', openCategories);
    q('mExport').addEventListener('click', exportBackup);
    q('mImport').addEventListener('click', () => { el.importFile.value = ''; el.importFile.click(); });
    q('mClose').addEventListener('click', closeSheet);
    showVersion(q('versionNote'));
  }

  // 動いている Service Worker のキャッシュ名からバージョンを表示（更新の確認用）
  function showVersion(node) {
    if (!('caches' in window)) { node.textContent = 'バージョン：—'; return; }
    caches.keys().then((keys) => {
      const k = keys.find((x) => x.startsWith('ts-cache-'));
      node.textContent = 'バージョン：' + (k ? k.replace('ts-cache-', '') : '—');
    }).catch(() => { node.textContent = 'バージョン：—'; });
  }

  // ===== 前日の計画をコピー =====
  function openCopyPrev() {
    const prevKey = addDays(curDate, -1);
    const pd = parseKey(prevKey);
    const prevLabel = `前日（${pd.getMonth() + 1}/${pd.getDate()}）`;
    const src = loadDay(prevKey).plan.filter((b) => b.end != null);
    if (!src.length) { toast(`${prevLabel}の計画はありません`); return; }

    const doCopy = (replace) => {
      const copies = src.map((b) => ({ id: uid(), start: b.start, end: b.end, title: b.title || '', cat: b.cat, memo: b.memo || '' }));
      day.plan = replace ? copies : day.plan.concat(copies);
      saveDay(curDate, day);
      closeSheet();
      render();
      toast(`${prevLabel}の計画 ${copies.length}件をコピーしました`);
    };

    const back = '<button type="button" class="back-btn" id="cpBack">‹ 設定に戻る</button>';
    if (!day.plan.length) {
      openSheet(`${back}
        <h2>前日の計画をコピー</h2>
        <p class="sub">${prevLabel}の計画 ${src.length}件 を、この日の計画にコピーします。</p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cpCancel">キャンセル</button>
          <button type="button" class="btn primary" id="cpAdd">コピーする</button>
        </div>`);
    } else {
      openSheet(`${back}
        <h2>前日の計画をコピー</h2>
        <p class="sub">${prevLabel}の計画：${src.length}件<br>この日の計画：${day.plan.length}件（すでにあります）</p>
        <div class="menu-list">
          <button type="button" class="menu-item" id="cpAdd"><span class="icon">➕</span><span class="label">追加する<span class="desc">この日の計画は残したまま、前日の分を加えます</span></span></button>
          <button type="button" class="menu-item" id="cpReplace"><span class="icon">🔁</span><span class="label">置き換える<span class="desc">この日の計画を消して、前日の計画にします</span></span></button>
        </div>
        <div class="sheet-actions"><button type="button" class="btn" id="cpCancel">キャンセル</button></div>`);
      el.sheetBody.querySelector('#cpReplace').addEventListener('click', () => {
        if (confirm(`この日の計画 ${day.plan.length}件 を消して、前日の計画に置き換えます。よろしいですか？`)) doCopy(true);
      });
    }
    el.sheetBody.querySelector('#cpAdd').addEventListener('click', () => doCopy(false));
    el.sheetBody.querySelector('#cpCancel').addEventListener('click', closeSheet);
    el.sheetBody.querySelector('#cpBack').addEventListener('click', openMenu);
  }

  // ===== カテゴリの追加・編集 =====
  const PALETTE = [
    '#4b4fb8', '#2f6fec', '#9146c9', '#e07b00', '#23944f', '#0a8f9e', '#d9468d', '#737b8c',
    '#c0392b', '#b8860b', '#6d4c41', '#00897b', '#5c6bc0', '#558b2f', '#c2185b', '#455a64',
  ];

  function saveCategories() { store.set('categories', categories); }

  function openCategories() {
    const act = activeCats();
    const del = categories.filter((c) => c.deleted);
    const row = (c) => `<button type="button" class="menu-item" data-id="${esc(c.id)}">` +
      `<span class="dot" style="background:${esc(c.color)}"></span><span class="label">${esc(c.name)}</span><span class="chev">›</span></button>`;
    openSheet(`
      <button type="button" class="back-btn" id="ctBack">‹ 設定に戻る</button>
      <h2>カテゴリ</h2>
      <p class="sub">タップすると名前と色を変更できます。変更は記録済みのブロックにも反映されます。</p>
      <div class="menu-list" id="ctList">${act.map(row).join('')}</div>
      <div class="sheet-actions"><button type="button" class="btn primary" id="ctAdd">＋ カテゴリを追加</button></div>
      ${del.length ? `<h3>削除したカテゴリ</h3>
        <div class="menu-list">${del.map((c) => `<div class="menu-item is-deleted"><span class="dot" style="background:${esc(c.color)}"></span>` +
          `<span class="label">${esc(c.name)}</span><button type="button" class="small-btn" data-restore="${esc(c.id)}">元に戻す</button></div>`).join('')}</div>
        <p class="note">削除したカテゴリで記録済みのブロックは、そのまま残っています。</p>` : ''}
    `);
    el.sheetBody.querySelector('#ctBack').addEventListener('click', openMenu);
    el.sheetBody.querySelector('#ctAdd').addEventListener('click', () => openCategoryEdit(null));
    el.sheetBody.querySelectorAll('#ctList .menu-item').forEach((b) => {
      b.addEventListener('click', () => openCategoryEdit(b.dataset.id));
    });
    el.sheetBody.querySelectorAll('[data-restore]').forEach((b) => {
      b.addEventListener('click', () => {
        const c = categories.find((x) => x.id === b.dataset.restore);
        if (c) { delete c.deleted; saveCategories(); render(); toast(`「${c.name}」を元に戻しました`); }
        openCategories();
      });
    });
  }

  function openCategoryEdit(id) {
    const isNew = id == null;
    const cat = isNew ? null : categories.find((c) => c.id === id);
    if (!isNew && !cat) { openCategories(); return; }
    const used = PALETTE.filter((p) => !categories.some((c) => !c.deleted && c.color.toLowerCase() === p.toLowerCase()));
    let color = cat ? cat.color : (used[0] || PALETTE[0]);
    const canDelete = !isNew && activeCats().length > 1;

    openSheet(`
      <button type="button" class="back-btn" id="ceBack">‹ カテゴリ一覧に戻る</button>
      <h2>${isNew ? 'カテゴリを追加' : 'カテゴリを編集'}</h2>
      <div class="field">
        <label for="ceName">名前</label>
        <input type="text" id="ceName" maxlength="12" placeholder="例：勉強" value="${esc(cat ? cat.name : '')}" enterkeyhint="done">
      </div>
      <div class="field">
        <span class="field-label">色</span>
        <div class="swatches">${PALETTE.map((p) =>
          `<button type="button" class="swatch" data-color="${p}" style="background:${p}" aria-label="色 ${p}"></button>`).join('')}</div>
        <label class="custom-color">ほかの色：<input type="color" id="ceColor" value="${esc(color)}"></label>
      </div>
      <div class="field">
        <span class="field-label">見本</span>
        <div class="cat-preview" id="cePreview"></div>
      </div>
      <div class="sheet-actions">
        ${canDelete ? '<button type="button" class="btn danger" id="ceDelete">削除</button>' : ''}
        <button type="button" class="btn" id="ceCancel">キャンセル</button>
        <button type="button" class="btn primary" id="ceSave">${isNew ? '追加' : '保存'}</button>
      </div>
      ${canDelete ? '<p class="note">削除しても、このカテゴリで記録済みのブロックは元の名前・色のまま残ります（新しく選べなくなるだけです）。</p>' : ''}
    `);
    const q = (s) => el.sheetBody.querySelector(s);
    const nameEl = q('#ceName'), preview = q('#cePreview'), picker = q('#ceColor');
    const update = () => {
      preview.style.backgroundColor = color;
      preview.textContent = nameEl.value.trim() || '（名前）';
      el.sheetBody.querySelectorAll('.swatch').forEach((s) =>
        s.classList.toggle('is-selected', s.dataset.color.toLowerCase() === color.toLowerCase()));
    };
    el.sheetBody.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
      color = s.dataset.color; picker.value = color; update();
    }));
    picker.addEventListener('input', () => { color = picker.value; update(); });
    nameEl.addEventListener('input', update);
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    update();

    q('#ceBack').addEventListener('click', openCategories);
    q('#ceCancel').addEventListener('click', openCategories);
    q('#ceSave').addEventListener('click', () => {
      const name = nameEl.value.trim();
      if (!name) { toast('名前を入力してください'); return; }
      if (activeCats().some((c) => c.name === name && c.id !== id)) { toast(`「${name}」はすでにあります`); return; }
      if (isNew) categories.push({ id: 'c' + uid(), name, color });
      else { cat.name = name; cat.color = color; }
      saveCategories();
      render();
      toast(isNew ? `「${name}」を追加しました` : `「${name}」を保存しました`);
      openCategories();
    });
    const delBtn = q('#ceDelete');
    if (delBtn) delBtn.addEventListener('click', () => {
      if (!confirm(`カテゴリ「${cat.name}」を削除しますか？\n記録済みのブロックはそのまま残ります。`)) return;
      cat.deleted = true;   // 実際には消さずに印を付ける
      saveCategories();
      render();
      toast(`「${cat.name}」を削除しました`);
      openCategories();
    });
  }

  // ===== ファイル保存（iPhoneは共有シート、PCはダウンロード） =====
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  async function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    if (IS_IOS && navigator.canShare && typeof File === 'function') {
      const file = new File([blob], name, { type });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return true; }
        catch (e) { if (e && e.name === 'AbortError') return false; /* 失敗したらダウンロードを試す */ }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  }

  // ===== CSV書き出し（表示中の日） =====
  const hhmm = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function exportCSV() {
    const rows = [['日付', '種別', '開始', '終了', 'カテゴリ', '内容', 'メモ']];
    for (const kind of ['plan', 'actual']) {
      for (const b of day[kind].slice().sort((a, c) => a.start - c.start)) {
        rows.push([curDate, KIND_LABEL[kind], hhmm(b.start), b.end == null ? '' : hhmm(b.end),
          catById(b.cat).name, b.title || '', b.memo || '']);
      }
    }
    if (rows.length === 1) { toast('この日の記録はありません'); return; }
    // 先頭の BOM は Excel で文字化けさせないため
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    saveFile(`keikaku_${curDate}.csv`, csv, 'text/csv').then((ok) => { if (ok) toast('CSVを書き出しました'); });
  }

  // ===== バックアップ（JSON） =====
  const BACKUP_APP = 'keikaku-jikkou';

  function allDayKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY + 'day:')) keys.push(k.slice(KEY.length + 4));
    }
    return keys.sort();
  }

  function exportBackup() {
    const days = {};
    for (const date of allDayKeys()) days[date] = loadDay(date);
    const data = {
      app: BACKUP_APP,
      format: 1,
      exportedAt: new Date().toISOString(),
      categories,
      running: store.get('running', null),
      days,
    };
    const n = new Date();
    const name = `keikaku-backup_${dateKey(n)}_${pad2(n.getHours())}${pad2(n.getMinutes())}.json`;
    saveFile(name, JSON.stringify(data, null, 1), 'application/json').then((ok) => {
      if (!ok) return;
      store.set('lastBackup', Date.now());
      toast(`バックアップを書き出しました（${Object.keys(days).length}日分）`);
      if (!el.sheet.hidden && el.sheetBody.querySelector('#mExport')) openMenu();
    });
  }

  // 読み込んだデータの形をチェックして整える（おかしなデータは取り除く）
  function normalizeBlock(b, kind) {
    if (!b || typeof b !== 'object') return null;
    let start = Number(b.start);
    if (!Number.isFinite(start)) return null;
    start = clamp(snap(start), 0, DAY_MIN - SNAP);
    let end = b.end == null ? null : Number(b.end);
    if (end != null) {
      if (!Number.isFinite(end)) return null;
      end = clamp(snap(end), start + SNAP, DAY_MIN);
    } else if (kind === 'plan') return null;
    return {
      id: typeof b.id === 'string' && b.id ? b.id : uid(),
      start, end,
      title: typeof b.title === 'string' ? b.title.slice(0, 60) : '',
      cat: typeof b.cat === 'string' ? b.cat : '',
      memo: typeof b.memo === 'string' ? b.memo.slice(0, 500) : '',
    };
  }

  function parseBackup(obj) {
    if (!obj || typeof obj !== 'object' || !obj.days || typeof obj.days !== 'object') return null;
    const cats = (Array.isArray(obj.categories) ? obj.categories : [])
      .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && /^#[0-9a-f]{6}$/i.test(c.color))
      .map((c) => (c.deleted ? { id: c.id, name: c.name.slice(0, 12), color: c.color, deleted: true } : { id: c.id, name: c.name.slice(0, 12), color: c.color }));
    const days = {};
    let blocks = 0;
    for (const [date, d] of Object.entries(obj.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !d) continue;
      const plan = (Array.isArray(d.plan) ? d.plan : []).map((b) => normalizeBlock(b, 'plan')).filter(Boolean);
      const actual = (Array.isArray(d.actual) ? d.actual : []).map((b) => normalizeBlock(b, 'actual')).filter(Boolean);
      if (!plan.length && !actual.length) continue;
      days[date] = { plan, actual };
      blocks += plan.length + actual.length;
    }
    const running = obj.running && typeof obj.running.date === 'string' && typeof obj.running.id === 'string' ? obj.running : null;
    return { categories: cats, days, running, blocks, exportedAt: obj.exportedAt };
  }

  el.importFile.addEventListener('change', () => {
    const f = el.importFile.files && el.importFile.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj;
      try { obj = JSON.parse(String(reader.result).replace(/^﻿/, '')); }
      catch (e) { toast('JSONファイルとして読み込めませんでした'); return; }
      const bk = parseBackup(obj);
      if (!bk || (obj.app && obj.app !== BACKUP_APP)) { toast('このアプリのバックアップファイルではありません'); return; }
      openImportConfirm(bk, f.name);
    };
    reader.onerror = () => toast('ファイルを読み込めませんでした');
    reader.readAsText(f);
  });

  function openImportConfirm(bk, fileName) {
    const when = bk.exportedAt && !isNaN(Date.parse(bk.exportedAt))
      ? new Date(bk.exportedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '不明';
    const nDays = Object.keys(bk.days).length;
    openSheet(`
      <button type="button" class="back-btn" id="imBack">‹ 設定に戻る</button>
      <h2>バックアップの読み込み</h2>
      <p class="sub">${esc(fileName)}<br>書き出し日時：${esc(when)}<br>${nDays}日分・ブロック${bk.blocks}件・カテゴリ${bk.categories.length}個</p>
      <div class="menu-list">
        <button type="button" class="menu-item" id="imMerge"><span class="icon">➕</span><span class="label">統合する（おすすめ）<span class="desc">今のデータは残したまま、バックアップの内容を加えます。同じブロックはバックアップの内容になります</span></span></button>
        <button type="button" class="menu-item" id="imReplace"><span class="icon">⚠️</span><span class="label">置き換える<span class="desc">この端末のデータをすべて消して、バックアップの内容だけにします</span></span></button>
      </div>
      <div class="sheet-actions"><button type="button" class="btn" id="imCancel">キャンセル</button></div>
    `);
    const q = (s) => el.sheetBody.querySelector(s);
    q('#imBack').addEventListener('click', openMenu);
    q('#imCancel').addEventListener('click', closeSheet);
    q('#imMerge').addEventListener('click', () => applyImport(bk, false));
    q('#imReplace').addEventListener('click', () => {
      if (!confirm('この端末の記録をすべて消して、バックアップの内容に置き換えます。\n元に戻せません。よろしいですか？')) return;
      if (!confirm('最終確認：本当に置き換えますか？\n（不安な場合は、先に今のデータを書き出してください）')) return;
      applyImport(bk, true);
    });
  }

  function applyImport(bk, replace) {
    const before = store.get('running', null);
    if (replace) {
      for (const date of allDayKeys()) store.remove('day:' + date);
      store.remove('running');
      categories = bk.categories.length ? bk.categories : DEFAULT_CATEGORIES.slice();
      for (const [date, d] of Object.entries(bk.days)) saveDay(date, d);
    } else {
      // カテゴリ：同じIDは上書き、新しいものは追加
      for (const c of bk.categories) {
        const i = categories.findIndex((x) => x.id === c.id);
        if (i >= 0) categories[i] = c; else categories.push(c);
      }
      // ブロック：日付ごとに、同じIDは上書き、新しいものは追加（今のブロックは消さない）
      for (const [date, d] of Object.entries(bk.days)) {
        const cur = loadDay(date);
        for (const kind of ['plan', 'actual']) {
          for (const b of d[kind]) {
            const i = cur[kind].findIndex((x) => x.id === b.id);
            if (i >= 0) cur[kind][i] = b; else cur[kind].push(b);
          }
        }
        saveDay(date, cur);
      }
    }
    saveCategories();

    // 記録中のブロックは1つだけにする（それ以外の「記録中」は5分で閉じる）
    const keep = replace ? bk.running : (before || bk.running);
    let keptOk = false;
    for (const date of Object.keys(bk.days)) {
      const d = loadDay(date);
      let changed = false;
      for (const b of d.actual) {
        if (b.end != null) continue;
        if (keep && keep.date === date && keep.id === b.id) { keptOk = true; continue; }
        b.end = Math.min(b.start + SNAP, DAY_MIN);
        changed = true;
      }
      if (changed) saveDay(date, d);
    }
    if (keep && (keptOk || (!replace && keep === before))) store.set('running', keep);
    else store.remove('running');

    categories = loadCategories();
    day = loadDay(curDate);
    closeSheet();
    render();
    toast(replace ? 'バックアップの内容に置き換えました' : 'バックアップを統合しました');
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
  el.summaryBtn.addEventListener('click', openSummary);
  el.menuBtn.addEventListener('click', openMenu);

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
  // 端末の空き容量が少ないときも、データを消さないようブラウザに依頼する
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
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
