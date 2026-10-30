import assert from 'node:assert/strict';

// Inspect what the browser paints, including CSS pseudo-elements and shadow roots.
export async function assertNoUiEmoji(page) {
    const violations = await page.evaluate(() => {
        const result = [];
        const emoji = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Extended_Pictographic}|[0-9#*]\uFE0F?\u20E3/u;
        const inspect = (value, element, kind) => {
            if (emoji.test(value.replace(/[\u00a9\u00ae]/gu, ''))) {
                result.push({ tag: element.tagName, class: String(element.className), kind, value: value.slice(0, 160) });
            }
        };
        const walk = root => {
            for (const element of root.querySelectorAll('*')) {
                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) continue;
                for (const node of element.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) inspect(node.textContent ?? '', element, 'text');
                }
                for (const pseudo of ['::before', '::after']) {
                    const content = getComputedStyle(element, pseudo).content;
                    if (content !== 'none' && content !== 'normal') inspect(content, element, pseudo);
                }
                for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) inspect(element.getAttribute(attribute) ?? '', element, attribute);
                if (element.shadowRoot) walk(element.shadowRoot);
            }
        };
        walk(document);
        return result;
    });
    assert.deepEqual(violations, [], 'Visible application content must not generate emoji');
}
