const { chromium } = await import(process.env.PLAYWRIGHT_CORE);
const browser = await chromium.launch({ executablePath: process.env.BIN, headless: false });
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
await page.goto(`file://${process.cwd()}/index.html`);
await page.waitForTimeout(1200);
const measure = (label) => page.evaluate((label) => {
  const scroller = document.querySelector('.legend-list-content-container').parentElement;
  const sized = scroller.querySelector(':scope > .legend-list-content-container > div[style*="position: relative"]');
  const wraps = [...sized.children].filter((w) => w.style.position === 'absolute');
  const rects = wraps.map((w) => ({ top: w.getBoundingClientRect().top - sized.getBoundingClientRect().top, h: w.getBoundingClientRect().height, name: w.textContent.trim().slice(0, 9) })).sort((a, b) => a.top - b.top);
  const vpTop = scroller.getBoundingClientRect().top;
  const vpBottom = scroller.getBoundingClientRect().bottom;
  const base = sized.getBoundingClientRect().top;
  const inView = rects.filter((r) => base + r.top < vpBottom && base + r.top + r.h > vpTop);
  let overlaps = 0, gaps = 0;
  for (let i = 1; i < rects.length; i += 1) { const d = rects[i].top - (rects[i - 1].top + rects[i - 1].h); if (d < -0.5) overlaps += 1; }
  for (let i = 1; i < inView.length; i += 1) { const d = inView[i].top - (inView[i - 1].top + inView[i - 1].h); if (d > 0.5) gaps += 1; }
  const covered = inView.length ? Math.round((base + inView[0].top <= vpTop + 1 ? 1 : 0) + (base + inView[inView.length - 1].top + inView[inView.length - 1].h >= vpBottom - 1 ? 1 : 0)) : 0;
  const firstVisible = rects.find((r) => r.top + r.h + sized.getBoundingClientRect().top > vpTop + 1)?.name;
  const realScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop').get.call(scroller);
  const blankTop = rects.length ? Math.round(rects[0].top + sized.getBoundingClientRect().top - vpTop) : null;
  return { label, rows: rects.length, rowH: Math.round(rects[0]?.h ?? 0), listH: sized.style.height, first: rects[0]?.top, step: rects[1] ? rects[1].top - rects[0].top : null, overlaps, gapsInView: gaps, viewportCovered: covered === 2, inView: inView.length, firstVisible, realScrollTop, seenScrollTop: scroller.scrollTop, blankTop: blankTop > 0 ? blankTop : 0 };
}, label);
console.log(JSON.stringify(await measure('baseline (list only)')));
await page.evaluate(() => {
  const add = (a) => { if (a.querySelector('.strip')) return; const s = document.createElement('div'); s.className = 'strip'; s.textContent = 'Buy $50 Buy $200 Sell 50%'; a.append(s); };
  for (const a of document.querySelectorAll('a[href*="/tokens/"]')) add(a);
  new MutationObserver(() => { for (const a of document.querySelectorAll('a[href*="/tokens/"]')) add(a); }).observe(document.documentElement, { childList: true, subtree: true });
  const scroller = document.querySelector('.legend-list-content-container').parentElement;
  tokenList.attach(scroller);
});
await page.waitForTimeout(500);
console.log(JSON.stringify(await measure('attached')));
for (const y of [300, 1500, 3000, 4600, 100, 0]) {
  await page.evaluate((y) => { const s = document.querySelector('.legend-list-content-container').parentElement; s.scrollTop = y; }, y);
  await page.waitForTimeout(500);
  console.log(JSON.stringify(await measure(`scrollTop=${y}`)));
}
// wheel scrolling like a person, small steps
await page.mouse.move(200, 300);
for (let i = 0; i < 20; i += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
await page.waitForTimeout(500);
console.log(JSON.stringify(await measure('after 20 wheel steps')));
await page.evaluate(() => tokenList.detach(document.querySelector('.legend-list-content-container').parentElement));
await page.waitForTimeout(300);
console.log(JSON.stringify(await measure('detached')));
await page.screenshot({ path: 'legend2.png' });
await browser.close();
