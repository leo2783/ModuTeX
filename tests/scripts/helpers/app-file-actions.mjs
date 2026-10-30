// SPDX-License-Identifier: Apache-2.0
export async function waitForFileActions(page) {
    await page.locator('details.file-menu > summary:visible, details.more-menu > summary:visible')
        .first().waitFor({ state: 'visible', timeout: 15000 });
}

export async function clickFileAction(page, name) {
    await waitForFileActions(page);
    const fileMenu = page.locator('details.file-menu');
    const menu = await fileMenu.isVisible() ? fileMenu : page.locator('details.more-menu');
    if (!await menu.evaluate(element => element.open)) {
        await menu.locator(':scope > summary').click();
    }
    await menu.getByRole('button', { name }).click();
}
