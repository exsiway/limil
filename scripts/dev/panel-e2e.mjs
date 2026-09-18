// End-to-end check of the feed mirror in a real Chromium with the extension
// loaded: a logged-out FOMO tab gets a synthetic block, the panel page must
// mirror it, follow mutations, forward clicks, scrolls and button presses.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE);

const ID = 'fmjcaabdnlaefjlbkhidnonbpciangdc';
const ctx = await chromium.launchPersistentContext(process.env.PROFILE, {
  executablePath: process.env.BIN, headless: false, viewport: { width: 1200, height: 900 },
  args: [`--disable-extensions-except=${process.env.EXT}`, `--load-extension=${process.env.EXT}`, '--no-first-run'],
});
const out = {};
const worker = () => ctx.serviceWorkers()[0];
try {
  const fomo = await ctx.newPage();
  await fomo.goto('https://fomo.family/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await fomo.waitForTimeout(2500);
  await fomo.reload({ waitUntil: 'load' });
  await fomo.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await fomo.waitForTimeout(3000);

  // The block: four tab buttons, a virtualised card list with STALE tops
  // (rows 40px tall placed 30px apart) and a hostile image.
  await fomo.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'synthetic-block';
    block.setAttribute('style', 'position:fixed;left:0;top:0;width:340px;height:600px;background:#12111a;color:#fff;display:flex;flex-direction:column;z-index:99999');
    const strip = document.createElement('div');
    for (const name of ['Alerts', 'Tokens', 'Leaderboard', 'Feed']) {
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => { window.__clicked = (window.__clicked ?? []).concat(name); });
      strip.append(b);
    }
    const list = document.createElement('div');
    list.id = 'list';
    list.setAttribute('style', 'flex:1;overflow-y:auto');
    const virtual = document.createElement('div');
    virtual.id = 'virtual';
    virtual.setAttribute('style', 'height: 4000px; opacity: 1; position: relative;');
    for (let i = 0; i < 40; i += 1) {
      const wrap = document.createElement('div');
      wrap.setAttribute('style', `contain: layout style paint; left: 0px; position: absolute; right: 0px; top: ${100 + i * 30}px;`);
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('style', 'height:40px');
      card.textContent = `card ${i}`;
      wrap.append(card);
      virtual.append(wrap);
    }
    list.append(virtual);
    const bad = document.createElement('img');
    bad.setAttribute('src', 'https://evil.example/x.png');
    bad.setAttribute('onerror', 'window.__pwned = 1');
    list.prepend(bad);
    list.addEventListener('scroll', () => { window.__scrollTop = list.scrollTop; });
    block.append(strip, list);
    document.body.append(block);
  });

  // Quick buy and sell on, from the worker, as the popup would.
  await worker().evaluate(async () => {
    const settings = { quickBuyEnabled: true, quickBuyAmounts: [50, 200], quickSellPercent: 25, quickBuyConfirm: true };
    await chrome.storage.local.set({ settings });
    const [tab] = await chrome.tabs.query({ url: ['https://fomo.family/*'] });
    return chrome.tabs.sendMessage(tab.id, { type: 'quick.update', payload: settings });
  });

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => { (out.errors ??= []).push(String(e).slice(0, 200)); });
  await panel.goto(`chrome-extension://${ID}/dist/panel.html`);
  await panel.waitForFunction(() => /live|not on|no FOMO/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  out.status1 = await panel.locator('#status').textContent();
  out.cards = await panel.locator('#host .lm-shelf .card').count();
  out.badImg = await panel.evaluate(() => { const i = document.querySelector('#host img'); return i ? { src: i.getAttribute('src'), onerror: i.getAttribute('onerror') } : 'no img'; });

  // The Tokens list appears only now, after the panel is live, with FOMO's
  // exact nesting: scroller, legend-list content container, an empty div,
  // the sized relative list, absolute wrappers with STALE tops (53px apart),
  // each an animated grid item holding one link laid out like FOMO's row.
  await fomo.evaluate(() => {
    const block = document.getElementById('synthetic-block');
    const tokens = document.createElement('div');
    tokens.id = 'tokens';
    tokens.className = 'h-full overflow-x-hidden';
    tokens.setAttribute('style', 'overflow-x: auto; overflow-y: auto; height: 300px;');
    const content = document.createElement('div');
    content.className = 'legend-list-content-container';
    content.setAttribute('style', 'display: block; min-height: 100%; box-sizing: border-box;');
    content.append(document.createElement('div'));
    const sized = document.createElement('div');
    sized.setAttribute('style', 'height: 3657px; opacity: 1; position: relative;');
    const rowsSpec = [['robinhood', '0x39dbed3a2bd333467115de45665cc57f813c4571', 'PONS'], ['bnb', '0x7c8d0000000000000000000000000000000000ab', 'BNC4'], ['bnb', '0x7c8d0000000000000000000000000000000000ac', 'VLAD']];
    rowsSpec.forEach(([chain, addr, sym], i) => {
      const wrap = document.createElement('div');
      wrap.setAttribute('style', `contain: layout style paint; left: 0px; position: absolute; right: 0px; top: ${i * 53}px;`);
      const item = document.createElement('div');
      item.className = 'grid transition-[grid-template-rows,opacity] duration-150 ease-out grid-rows-[1fr] opacity-100';
      const box = document.createElement('div');
      box.className = 'overflow-hidden';
      const link = document.createElement('a');
      link.className = 'flex items-center gap-3 p-2 py-2 rounded-lg';
      link.href = `/tokens/${chain}/${addr}`;
      link.setAttribute('style', 'display: flex; width: 311px; box-sizing: border-box; padding: 8px; min-height: 52px;');
      const name = document.createElement('span');
      name.className = 'text-sm leading-4 truncate';
      name.textContent = sym;
      link.append(name);
      link.addEventListener('click', (ev) => { ev.preventDefault(); window.__navigated = (window.__navigated ?? 0) + 1; });
      box.append(link);
      item.append(box);
      wrap.append(item);
      sized.append(wrap);
    });
    content.append(sized);
    tokens.append(content);
    block.append(tokens);
  });
  await panel.waitForTimeout(1200);

  out.tokenRowGeometry = await fomo.evaluate(() => [...document.querySelectorAll('.lc-feedbuy-token')].map((strip) => {
    const link = strip.parentElement;
    const text = link.querySelector('.truncate');
    const wrap = strip.closest('[style*="position: absolute"]');
    const s = strip.getBoundingClientRect(); const l = link.getBoundingClientRect(); const t = text.getBoundingClientRect();
    return { insideLink: link.localName === 'a', wrapH: Math.round(wrap.getBoundingClientRect().height), linkH: Math.round(l.height), belowText: s.top >= t.bottom, insideLinkBox: s.bottom <= l.bottom + 0.5 && s.left >= l.left, stripW: Math.round(s.width), labels: [...strip.querySelectorAll('button')].map((b) => b.textContent) };
  }));
  // The page's own world reads the scroll position divided by the ratio; the real one is what it is.
  out.scrollScale = await fomo.evaluate(() => {
    const scroller = document.getElementById('tokens');
    const attr = scroller.getAttribute('data-limil-scroll-scale');
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    scroller.scrollTop = 130;
    const out = { attr, own: Object.prototype.hasOwnProperty.call(scroller, 'scrollTop'), real: native.get.call(scroller), seen: scroller.scrollTop, listH: scroller.querySelector('[style*="position: relative"]').style.height };
    scroller.scrollTop = 0;
    return out;
  });
  out.awake = await fomo.evaluate(() => ({ state: document.visibilityState, hidden: document.hidden }));
  out.awakeStatus = await worker().evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://fomo.family/*'] });
    return chrome.tabs.sendMessage(tab.id, { type: 'page.awake.status' }).catch((e) => String(e));
  });
  out.panelRows = await panel.evaluate(() => ({ rows: document.querySelectorAll('#host .lm-shelf .lc-feedbuy').length, tokenRows: document.querySelectorAll('#host .lm-shelf .lc-feedbuy-token').length }));
  out.tokensLayout = await panel.evaluate(() => {
    const link = document.querySelector('#host .lm-shelf a[href*="/tokens/"]');
    const shelf = link?.closest('.lm-shelf');
    if (!shelf) return 'no shelf';
    const rows = [...shelf.children].map((r) => r.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 1; i < rows.length; i += 1) if (rows[i].top < rows[i - 1].bottom - 0.5) overlaps += 1;
    return { shelf: true, rows: rows.length, heights: rows.map((r) => Math.round(r.height)), overlaps, sourceHidden: getComputedStyle(link.closest('.lm-source') ?? document.body).display === 'none' || !link.closest('.lm-source') };
  });

  // A press in the panel arms the button in the tab; the sell one too; no navigation.
  await panel.locator('#host .lm-shelf .lc-feedbuy-token button').first().click();
  await panel.locator('#host .lm-shelf .lc-feedbuy-token button.lc-sell').first().click();
  await panel.waitForTimeout(400);
  out.armed = {
    tab: await fomo.evaluate(() => document.querySelector('.lc-feedbuy-token button').textContent),
    panel: await panel.locator('#host .lm-shelf .lc-feedbuy-token button').first().textContent(),
    sellTab: await fomo.evaluate(() => document.querySelector('.lc-feedbuy-token button.lc-sell').textContent),
    sellPanel: await panel.locator('#host .lm-shelf .lc-feedbuy-token button.lc-sell').first().textContent(),
    navigated: await fomo.evaluate(() => window.__navigated ?? 0),
  };

  // A mutation in the tab: one more card, a text change.
  await fomo.evaluate(() => {
    const list = document.getElementById('virtual');
    const wrap = document.createElement('div');
    wrap.setAttribute('style', 'contain: layout style paint; left: 0px; position: absolute; right: 0px; top: 70px;');
    const card = document.createElement('div');
    card.className = 'card fresh';
    card.textContent = 'card new';
    wrap.append(card);
    list.prepend(wrap);
    list.children[2].firstChild.textContent = 'card changed';
  });
  await panel.waitForTimeout(500);
  out.cardsAfter = await panel.locator('#host .lm-shelf .card').count();
  out.changed = await panel.evaluate(() => [...document.querySelectorAll('#host .lm-shelf .card')].map((c) => c.textContent).slice(0, 4));
  out.layout = await panel.evaluate(() => {
    const card = document.querySelector('#host .lm-shelf .card');
    const shelf = card?.closest('.lm-shelf');
    if (!shelf) return 'no shelf';
    const rows = [...shelf.children].map((r) => r.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 1; i < rows.length; i += 1) if (rows[i].top < rows[i - 1].bottom - 0.5) overlaps += 1;
    return { shelf: true, rows: rows.length, overlaps, first: shelf.children[0]?.textContent.slice(0, 12) };
  });
  out.aeonik = await panel.evaluate(() => {
    const loaded = [...document.fonts].filter((f) => f.family === 'Aeonik' && f.status === 'loaded').map((f) => f.weight);
    const width = (family) => { const s = document.createElement('span'); s.style.font = `14px ${family}`; s.textContent = 'The cavalry is around the corner'; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
    return { loaded, aeonikWidth: width('Aeonik'), systemWidth: width('system-ui') };
  });
  out.pageAeonikWidth = await fomo.evaluate(async () => {
    await document.fonts.load('14px Aeonik');
    const s = document.createElement('span'); s.style.font = '14px Aeonik'; s.textContent = 'The cavalry is around the corner';
    document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w;
  });

  // A click in the panel lands in the tab; a scroll too.
  await panel.locator('#host button', { hasText: 'Leaderboard' }).click();
  // Scrolled the way a person does it: a wheel over the list, not a scrollTop set by a script.
  const listBox = await panel.locator('#host [style*="overflow-y"]').first().boundingBox();
  await panel.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  await panel.mouse.wheel(0, 400);
  await panel.waitForTimeout(800);
  out.clicked = await fomo.evaluate(() => window.__clicked ?? null);
  out.scrollTop = await fomo.evaluate(() => window.__scrollTop ?? null);
  out.pwned = await fomo.evaluate(() => window.__pwned ?? null);
  out.panelPwned = await panel.evaluate(() => window.__pwned ?? null);
  await panel.screenshot({ path: process.env.SHOT });

  // The block leaves the page: the panel says so. The panel closes: the tab is honest again.
  await fomo.evaluate(() => document.getElementById('synthetic-block').remove());
  await panel.waitForFunction(() => !/live/.test(document.getElementById('status').textContent), null, { timeout: 5000 }).catch(() => {});
  out.status2 = await panel.locator('#status').textContent();
  await panel.close();
  await fomo.waitForTimeout(800);
  out.afterClose = await worker().evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://fomo.family/*'] });
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'feed.status' }).catch((e) => String(e));
    const awake = await chrome.tabs.sendMessage(tab.id, { type: 'page.awake.status' }).catch((e) => String(e));
    return { status, awake };
  });
} catch (err) {
  out.error = String(err?.stack || err).slice(0, 600);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
}
