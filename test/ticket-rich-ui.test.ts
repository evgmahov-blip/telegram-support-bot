import { boundedText, richProjection, richRejected, optionalRichProjection } from '../src/ticket-rich-ui';

describe('bounded pure Rich HTML projection', () => {
  it('uses the same authorized text and callbacks without introducing hidden data', () => {
    const html = richProjection('<b>Заявка #7</b>\n&lt;script&gt; &amp; текст', [[{text:'Взять <',callback_data:'rt:take:7:2'}]]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('type="callback_data" style="primary" data="rt:take:7:2"');
    expect(html).toContain('Взять &lt;');
    expect(html).not.toMatch(/<script|onclick|javascript:/);
  });
  it.each(['', 'я'.repeat(33), 'a\n'])('rejects invalid callback bytes %p', callback_data => {
    expect(() => richProjection('ok', [[{text:'x',callback_data}]] )).toThrow('invalid_callback');
  });
  it('keeps Unicode scalar boundaries and accepts 64 bytes', () => {
    expect(boundedText('😀'.repeat(600), 240)).toBe('😀'.repeat(240));
    expect(richProjection('ok', [[{text:'x',callback_data:'я'.repeat(32)}]])).toContain('tg-button');
  });
  it.each(['<script>x</script>', '<a href="javascript:x">x</a>', '<details>secret</details>', '<img src="x">'])('rejects non-whitelisted markup %s before transport', html => {
    expect(optionalRichProjection(html, [])).toBeUndefined();
  });
  it('allows only server canonical Telegram links', () => {
    expect(() => richProjection('ok', [[{text:'x',url:'javascript:alert(1)'}]])).toThrow();
    expect(richProjection('ok', [[{text:'x',url:'https://t.me/c/123/5?thread=7'}]])).toContain('type="url"');
  });
  it('distinguishes deterministic rejection from unknown outcomes and other failures', () => {
    expect(richRejected({error_code:400,description:"Bad Request: can't parse rich HTML"})).toBe(true);
    expect(richRejected({error_code:404,description:'Unknown method'})).toBe(true);
    for (const e of [new Error('timeout'),{error_code:500,description:'internal'}, {error_code:403,description:'blocked'}, {error_code:400,description:'message to edit not found'}]) expect(richRejected(e)).toBe(false);
  });
});

it('reproduces both first-screen fixtures through the shared view model', () => {
  const {renderClassic,renderRich}=require('../src/ticket-rich-ui');
  const fixtures=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'fixtures/telegram-rich-ui.json'),'utf8'));
  for (const fixture of Object.values(fixtures) as any[]) {
    const view={bodyHtml:fixture.bodyHtml,buttons:fixture.buttons};
    expect(renderClassic(view)).toEqual({text:fixture.classic.text,rows:fixture.classic.reply_markup.inline_keyboard});
    expect(renderRich(view)).toBe(fixture.rich_message.html);
  }
});
