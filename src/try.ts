import * as Puppyteer from './index';

(async () => {

    const pt = new Puppyteer.Puppyteer({
        headless: false,
        logActivity: true,
        taskRunner: {
            concurrencyLevel: 20,
            showStatus: true,
            showWorkerIdx: true,
        }
    })

    // Tasks to hit my pages
    for (let i = 0; i < 10; ++i) {
        pt.addPageTask({
            title: "Longform",
            tags: ["self"],
            url: 'https://longform.asmartbear.com',
        }, async ({ page, fStatus }) => {
            fStatus("Searching for ICP")
            const byDate = await page.waitForSelectorOrFail('button#by-date', {})
            await page.clickOnElement(byDate, {})
            const search = await page.waitForSelectorOrFail('input#search-input', {})
            await page.typeInElement(search, 'icp', {})
            const divs = await page.waitForAllSelectorsWithInner('div.title', /Carol/, { waitIn: "background" })
            const carol = divs[0]
            if (!carol) throw new Error("couldn't find carol");
            const link = await page.getMatchingParent(carol, 'a')
            if (!link) throw new Error("can't find the link")
            console.log(await page.getProperty(link, 'href'))
        })
    }

    // pt.addPageTask({
    //     title: "Blog",
    //     tags: ["self"],
    //     url: 'https://blog.asmartbear.com',
    // }, async ({ page, fStatus }) => {
    //     fStatus("Loading titles...")
    //     const list = await page.waitForAllSelectors('h2.wp-block-post-title')
    //     for (let h2 of list) {
    //         const title = await h2.evaluate(e => e.textContent)
    //         if (!title) continue
    //         const a = await h2.$('a')
    //         if (!a) continue

    //         pt.addPageTask({
    //             title: "Blog: " + title,
    //             tags: ["blog-post"],
    //             url: await a.evaluate(e => e.href),
    //         }, async ({ page }) => {
    //             // nothing else
    //         })
    //     }
    // })

    await pt.taskRunner.run()

})()
