// Visual/behavioural test on mock desktop-style pages at phone size.
// Run: NODE_PATH=$(npm root -g) node test/run.js   (needs playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const script = fs.readFileSync(require('path').join(__dirname,'..','atria-mobile.user.js'),'utf8');
(async()=>{
  const b = await chromium.launch();
  let fail = 0;
  const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) fail++;};
  for (const name of ['mockA','mockB']) {
    const ctx = await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,hasTouch:true,isMobile:true});
    const p = await ctx.newPage();
    p.on('pageerror',e=>{console.log('PAGEERR',e.message);fail++});
    await p.goto('file://'+__dirname+'/'+name+'.html');
    await p.screenshot({path:`/tmp/${name}-before.png`});
    await p.evaluate(script);
    await p.waitForTimeout(1500);
    await p.screenshot({path:`/tmp/${name}-after.png`});
    const r = await p.evaluate(()=>{
      const sb=document.querySelector('.am-sidebar');
      const grid=document.querySelector('.am-grid');
      const cards=grid?[...grid.children].map(c=>c.getBoundingClientRect()):[];
      return {sw:document.documentElement.scrollWidth, iw:innerWidth, hasSb:!!sb, sbRight:sb?sb.getBoundingClientRect().right:null,
        hasGrid:!!grid, cardW:cards.map(c=>Math.round(c.width)), cardL:cards.map(c=>Math.round(c.left)),
        menuVisible:getComputedStyle(document.querySelector('.am-btn')).display, mainLeft: document.querySelector('main,.main')?.getBoundingClientRect().left};
    });
    console.log(name, JSON.stringify(r));
    ok(r.sw<=r.iw+1, name+': no horizontal overflow');
    ok(r.hasSb && r.sbRight<=0, name+': sidebar off-canvas');
    ok(r.hasGrid && r.cardW.length>=6 && r.cardW.every(w=>w>300) && new Set(r.cardL).size===1, name+': single full-width column');
    await p.click('.am-dock .am-btn:first-child');
    await p.waitForTimeout(400);
    const open = await p.evaluate(()=>document.querySelector('.am-sidebar').getBoundingClientRect().left);
    ok(open>=-1, name+': drawer opens');
    await p.screenshot({path:`/tmp/${name}-drawer.png`});
    await p.click('.am-scrim',{position:{x:370,y:400}});
    await p.waitForTimeout(400);
    ok(await p.evaluate(()=>document.querySelector('.am-sidebar').getBoundingClientRect().right<=0), name+': scrim closes drawer');
    await p.click('.am-dock .am-btn:last-child');
    await p.click('[data-act=report]');
    const rep = await p.evaluate(()=>document.querySelector('.am-report').value);
    ok(rep.includes('"sidebar"')&&rep.includes('outline'), name+': debug report generated');
    await p.screenshot({path:`/tmp/${name}-panel.png`});
    await ctx.close();
  }
  await b.close();
  process.exit(fail?1:0);
})();
