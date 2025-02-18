import { Task, TaskExecutionFunction, TaskUpdateFunction } from "@asmartbear/jobs";
import { PageInfo, Puppyteer, TaskInfo } from "./browser";
import { isNonEmptyArray } from "./common";
import { ElementHandle, JSHandle, KeyboardTypeOptions, NodeFor, Page, Point, PuppeteerLifeCycleEvent } from "puppeteer";

export type GoOptions = {
    /**
     * The maximum amount of time to wait for the page to load
     */
    timeoutMs?: number,

    /**
     * Wait for page-load until one of these things happens.  Default is 'load'
     */
    waitUntil?: PuppeteerLifeCycleEvent,

    /**
     * Additional time to wait after the page as loaded.
     */
    waitAfterMs?: number,
}

export type SelectorOptions = {
    /**
     * The maximum amount of time to wait for the selector to match something.
     */
    timeoutMs?: number,

    /**
     * Whether to wait in the foreground or background; default is foreground.
     */
    waitIn?: "foreground" | "background",

    /**
     * If true, only if the element is DOM-visibile.
     */
    visible?: boolean,
}

export type ClickOptions = {
    /**
     * (Default: `true`) If true, and if the element isn't in the viewport, scroll into view.
     */
    scrollIntoView?: boolean,

    /**
     * (Default: 100ms) How much time to wait after finishing the click.
     */
    waitAfter?: number,

    /**
     * Whether to wait in the foreground or background after clicking the button; default is foreground.
     */
    waitIn?: "foreground" | "background",
}

export type TypeOptions = {
    /**
     * (Default: `true`) If true, and if the element isn't in the viewport, scroll into view.
     */
    scrollIntoView?: boolean,

    /**
     * (Default: `true`) If true, type slowly as if a human were typing.
     */
    slowTyping?: boolean,

    /**
     * (Default: 100ms) How much time to wait after finishing the typing.
     */
    waitAfter?: number,

    /**
     * Whether to wait in the foreground or background after finishing the typing; default is foreground.
     */
    waitIn?: "foreground" | "background",

    /**
     * If true, use `SHIFT-RETURN` to enter multiple lines, instead of just `RETURN`.
     */
    multiLinedShiftReturn?: boolean,

    /**
     * If true, send an "ENTER" keypress at the end of the message
     */
    pressReturnAtEnd?: boolean,
}

/**
 * Wraps a Puppeteer page with useful routines, locks, and jobs.
 */
export class PuppyteerPage {
    private statusStack: string[] = []

    /**
     * True if we're running in the foreground with the mutex, false otherwise.
     */
    private inForeground = false

    /**
     * Task information we can pass to all task functions.
     */
    private taskInfo: TaskInfo<string>

    /**
     * The underlying task-update function.
     */
    private fStatus: TaskUpdateFunction

    constructor(public readonly browser: Puppyteer<string>, public readonly page: Page, public readonly config: PageInfo<string>) {
        this.fStatus = config.fStatus
        this.taskInfo = { ...this.config, page: this, fStatus: (msg: string) => this.status(msg) }
    }

    /**
     * Update the current status, optionally pushing onto a stack
     */
    status(msg: string) {
        // If no stack, treat like a push
        if (!this.statusStack.length) {
            this.statusPush(msg)
            return
        }

        // Update the current message
        this.config.fStatus(msg)
        this.statusStack[this.statusStack.length - 1] = msg
    }

    /**
     * Pushes a new message on the stack, repeating the previous stack message.
     */
    statusPush(msg: string) {
        const prev = this.statusStack[this.statusStack.length - 1] ?? ""
        if (prev) {
            msg = `${prev} -- ${msg}`
        }
        this.config.fStatus(msg)
        this.statusStack.push(msg)
    }

    /**
     * Restores the status to the previous value
     * 
     * @param logActivity if false, don't log the activity to the console, even if generally this is requested.
     */
    statusPop(logActivity: boolean = true) {
        const msg = this.statusStack.pop()      // kill the current one
        if (logActivity && this.browser.logActivity) {
            console.log(msg)
        }
        this.config.fStatus(this.statusStack[this.statusStack.length - 1] ?? "")  // reinstate the previous one
    }

    /**
     * Navigates to a URL.
     */
    async goto(url: string, options: GoOptions) {
        this.status(`Navigating to ${url}`)
        await this.page.goto(url, {
            timeout: options.timeoutMs ?? 20000,
            waitUntil: options.waitUntil ?? 'load',
        })
        const waitAfterMs = options.waitAfterMs
        if (waitAfterMs && waitAfterMs > 0) {
            await this.wait(waitAfterMs, "background")
        }
    }

    /**
     * As if you pushed the browser "back" button.
     */
    async goBack(options: GoOptions) {
        this.status(`Going 'back'`)
        await this.page.goBack({
            timeout: options.timeoutMs ?? 20000,
            waitUntil: options.waitUntil ?? 'load',
        })
    }

    /**
     * Returns the URL the page is currently on.
     */
    get url(): string {
        return this.page.url()
    }

    /**
     * Runs the given code while the page is active.
     * Waits until the mutex is available for us to run.
     * Returns the result of the function.
     */
    async runInForeground<T>(fn: (info: TaskInfo<string>) => Promise<T>): Promise<T> {
        // If we're already in the foreground, just run it.
        if (this.inForeground) {
            return await fn(this.taskInfo)
        }

        // Wait and then run it
        await this.acquireActivePage()
        try {
            return await fn(this.taskInfo)
        } finally {
            this.releaseActivePage()
        }
    }

    /**
     * Runs the given code while the page not necessarily active.
     * Runs immediately since we don't need to wait for anything.
     * Returns the result of the function.
     */
    async runInBackground<T>(fn: (info: TaskInfo<string>) => Promise<T>): Promise<T> {
        // If we're already in the background, just run it
        if (!this.inForeground) {
            return await fn(this.taskInfo)
        }

        // Go into the background and run it.
        this.releaseActivePage()
        const r = await fn(this.taskInfo)
        await this.acquireActivePage()
        return r
    }

    /**
     * Runs the given code as a "Supabase" task, meaning that it runs in a separate task not attached to a webpage,
     * tagged as "supabase" for things like parallelism.  This allow us to release pages much quicker, even more so
     * than having it "run in background."
     * 
     * @returns the newly-created task, not as a Promise
     */
    runSupabaseTask(title: string, executionFunction: TaskExecutionFunction): Task<string> {
        return this.browser.taskRunner.addTask({
            title: title,
            tags: ["supabase"],
        }, executionFunction)
    }

    /**
     * Waits this many milliseconds, or 0 to yield, but does not release the active mutex.
     */
    wait(ms: number, waitIn?: "foreground" | "background"): Promise<void> {
        const f = async () => {
            this.statusPush(`Waiting ${ms}ms in ${waitIn}`)
            await new Promise(resolve => setTimeout(resolve, ms))
            this.statusPop(false)
        }

        // Run here or in background
        if (waitIn === "background") {
            return this.runInBackground(f)
        } else {
            return f()
        }
    }

    /**
     * Goes into the background, yielding control to some other foreground task.
     */
    yield(): Promise<void> {
        return this.wait(0, "background")
    }

    /**
     * Similar to waiting for `goto()` except we got there through navigation such as
     * clicking on a link, rather than just going to a URL.
     */
    waitForNavigation(goOptions: GoOptions, waitIn: "foreground" | "background") {
        const f = async () => {
            const timeout = goOptions.timeoutMs ?? 20000
            const waitUntil = goOptions.waitUntil ?? 'load'
            this.statusPush(`Waiting up to ${timeout}ms for navigation`)
            await this.page.waitForNavigation({ timeout, waitUntil })
            this.statusPop(false)
        }

        // Run here or in background
        if (waitIn === "background") {
            return this.runInBackground(f)
        } else {
            return f()
        }
    }

    /**
     * Gets any single match for the given selector.
     * Does not wait.  Returns `null` if not found.
     */
    async getSelectorImmediate<Selector extends string>(selector: Selector, options: Pick<SelectorOptions, "visible">): Promise<ElementHandle<NodeFor<Selector>> | null> {
        // If only visible, get all the results and return only the visible ones
        if (options.visible) {
            for (const h of await this.page.$$(selector)) {
                if (await this.isTrulyVisible(h)) {
                    return h
                }
            }
            return null
        }
        // We can do the fast way
        return await this.page.$(selector)
    }

    /**
     * Waits for any single match for the given selector.
     * By default, does not wait and runs in foreground.
     * Returns `null` if not found or timeout.
     */
    async waitForSelector<Selector extends string>(selector: Selector, options: SelectorOptions): Promise<ElementHandle<NodeFor<Selector>> | null> {

        // Try it immediately; maybe we don't need to wait.
        let result = await this.getSelectorImmediate(selector, options)
        if (result) return result

        // If there's no waiting anyway, we're done
        if (!options.timeoutMs) return null

        // Do the waiting
        this.statusPush(`Waiting for selector ${selector}`)
        try {
            const puppetOptions = {
                timeout: options.timeoutMs ?? 0,
                visible: options.visible,
            }
            if (options.waitIn === "background") {
                result = await this.runInBackground(() => {
                    return this.page.waitForSelector(selector, puppetOptions)
                })
            } else {
                result = await this.page.waitForSelector(selector, puppetOptions)
            }
        } catch (err) {
            return null
        } finally {
            this.statusPop(false)
        }

        // If there's no result, or if there's no additional conditions we need to check, the current result is correct.
        if (!result || !options.visible) return result

        // Use our more complex function since we need to do some computation
        return await this.getSelectorImmediate(selector, options)
    }

    /**
     * Same as `waitForSelector()` but throws an exception if the selector is not found, and therefore
     * also never returns `null`.
     */
    async waitForSelectorOrFail<Selector extends string>(selector: Selector, options: SelectorOptions): Promise<ElementHandle<NodeFor<Selector>>> {
        const r = await this.waitForSelector(selector, options)
        if (!r) throw new Error("Couldn't find required selector: " + selector)
        return r
    }

    /**
     * Same as `waitForSelector()` but returns all matches once the wait is over.
     */
    async waitForAllSelectors<Selector extends string>(selector: Selector, options: SelectorOptions = {}) {
        if (options.visible) throw new Error("`options.visble` for all-selectors not yet implemented")
        if (options.timeoutMs && options.timeoutMs > 0) {    // Wait only if waiting is requested
            if (!await this.waitForSelector(selector, options)) {   // wait for at least one
                return []     // in case of failure
            }
        }
        return await this.page.$$(selector)     // get all of them
    }

    /**
     * Waits for selectors to exist, further filtered by the inner text matching a regular expression.
     */
    async waitForAllSelectorsWithInner<Selector extends string>(selector: Selector, innerTextMatcher: RegExp, options: SelectorOptions = {}): Promise<ElementHandle<NodeFor<Selector>>[]> {
        const results: ElementHandle<NodeFor<Selector>>[] = []
        const startTime = Date.now()
        do {

            // Try to grab them now
            for (const h of await this.page.$$(selector)) {
                const innerText = await h.evaluate(el => el.textContent)
                if (innerText && innerTextMatcher.test(innerText.trim())) {
                    if (!options.visible || await this.isTrulyVisible(h)) {     // honor the "visibility" constraint, if it was provided
                        results.push(h)
                    }
                }
            }
            if (results.length > 0 || !options.timeoutMs) {     // if have something or no timeout, we're done
                break
            }

            // Busy-wait
            await this.wait(250, options.waitIn ?? "foreground")

        } while (Date.now() - startTime < options.timeoutMs)
        return results
    }

    /**
     * Same as waitForAllSelectorsWithInner() but returns just the first one, or `null` if none.
     */
    async waitForFirstSelectorWithInner<Selector extends string>(selector: Selector, innerTextMatcher: RegExp, options: SelectorOptions = {}): Promise<ElementHandle<NodeFor<Selector>> | null> {
        const results = await this.waitForAllSelectorsWithInner(selector, innerTextMatcher, options)
        return results[0] ?? null
    }

    /**
     * Same as waitForAllSelectorsWithInner() but returns just the last one, or `null` if none.
     */
    async waitForLastSelectorWithInner<Selector extends string>(selector: Selector, innerTextMatcher: RegExp, options: SelectorOptions = {}): Promise<ElementHandle<NodeFor<Selector>> | null> {
        const results = await this.waitForAllSelectorsWithInner(selector, innerTextMatcher, options)
        return results[results.length - 1] ?? null
    }

    /**
     * True if the given selector is present on the page.
     */
    async hasAnySelector<Selector extends string>(selector: Selector, options: SelectorOptions = {}): Promise<boolean> {
        // Maybe a more efficient way to do this in some common cases?
        return await this.waitForSelector(selector, options) !== null
    }

    /**
     * Goes up the parent chain, looking for the first element which matches the given selector, or `null` if none
     */
    async getMatchingParent<Selector extends string>(el: ElementHandle, selector: Selector): Promise<ElementHandle<NodeFor<Selector>> | null> {
        const result = await el.evaluateHandle((el, selector) => {
            let parent = el.parentElement
            while (parent) {
                if (parent.matches(selector)) {
                    return parent
                }
                parent = parent.parentElement
            }
            return null
        }, selector)
        if (result instanceof ElementHandle) {
            return result as ElementHandle<NodeFor<Selector>>
        }
        return null
    }

    /**
     * Gets the value of the attribute of the element, or `null` if missing.
     */
    async getAttribute(el: ElementHandle, name: string): Promise<string | null> {
        return await el.evaluate((el, name) => el.getAttribute(name), name)
    }

    /**
     * Gets the value of the property of the element, or `null` if missing,
     * which can be more computed than the attribute, e.g. the full URL for `href` instead of the literal value.
     */
    async getProperty<EH extends ElementHandle>(el: EH, name: string): Promise<string | null> {
        const h = await el.getProperty(name)
        const v = await h.jsonValue()
        if (!v) return null
        return v.toString()
    }

    /**
     * True if the element isn't visible in the DOM, or is nullish.
     */
    async isHidden(el: ElementHandle | null | undefined): Promise<boolean> {
        if (!el) return true
        return await el.evaluate(el => {
            if (el.getAttribute('aria-hidden')) return true
            const style = el.computedStyleMap()
            if (style.get('display')?.toString() === 'none') return true
            if (style.get('visibility')?.toString() === 'hidden') return true
            return false
        })
    }

    /**
     * Is this element visible, not just because its own computed style is visible and not opaque, but parents are too and so on.
     * If it is, returns the rectangle of its position, otherwise returns `null`.
     */
    async isTrulyVisible(el: ElementHandle | null | undefined): Promise<DOMRectReadOnly | null> {
        if (!el) return null
        return await el.evaluate(el => {

            // Element might be off-screen
            // console.log("Checking visibility of ", el.attributes)
            const rect = el.getBoundingClientRect()
            if (!('left' in rect) || rect.left === undefined || rect.top < 0 || rect.left < 0 || rect.width < 1 || rect.height < 1 ||
                rect.bottom > (window.innerHeight || document.documentElement.clientHeight) ||
                rect.right > (window.innerWidth || document.documentElement.clientWidth)
            ) {
                // console.log("off-screen", rect, (window.innerHeight || document.documentElement.clientHeight), (window.innerWidth || document.documentElement.clientWidth))
                return null
            }

            // Make sure that finding "the element at that point" actually finds this element
            const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
            let elAtPoint: Element | null = document.elementFromPoint(center.x, center.y)
            while (elAtPoint != el) {     // walk up the parent chain
                // console.log("finding element at point", elAtPoint)
                if (!elAtPoint) {
                    // console.log("no match")
                    return null     // went all the way up the parent chain and didn't match
                }
                elAtPoint = elAtPoint.parentElement
            }
            // console.log("got a match", elAtPoint)

            // Check styles of the element or any parent
            {
                let p: Element | null = el
                while (p) {
                    const style = window.getComputedStyle(p)
                    // console.log("checking style", style)
                    if (style.display == 'none' || style.visibility == 'hidden' || style.opacity == '0' || style.width == '0' || style.height == '0') return null
                    p = p.parentElement
                }
            }
            return rect.toJSON()
        })
    }

    /**
     * Given all elements that match the given selector, returns the topmost one on the page that is also visible.
     * 
     * @param selector CSS selector to check
     * @param parentLevel if greater than zero, actually pick the Nth parent of the element in question.
     */
    async getFirstVisibleElement(selector: string, parentLevel: number = 0): Promise<ElementHandle | null> {
        // Get list of visible elements, along with their bounding rectangles
        const els: {
            el: ElementHandle,
            rect: DOMRectReadOnly,
            idx: number,        // tiebreaker
        }[] = []
        let idx = 0
        const sources = await this.page.$$(selector)
        const visibleRects = await Promise.all(sources.map(el => this.isTrulyVisible(el)))
        // console.log(visibleRects)
        for (let k = 0; k < sources.length; ++k) {
            const visRect = visibleRects[k]
            if (visRect) {
                let el = sources[k]
                for (let i = 0; i < parentLevel; ++i) {     // pick the parent if requested
                    el = await el.evaluateHandle(e => e.parentElement ?? e)
                }

                // Load the bounding rectangle, and skip it if it doesn't exist
                // console.log("visible", selector, "as", await el.evaluate(e => e.getAttribute('role')), ":", r, "but was", visibleRects[k])
                els.push({
                    el: el,
                    rect: visRect,
                    idx: idx++,
                })
            }
        }
        if (isNonEmptyArray(els)) {
            // Sort, so we can pick the topmost one
            els.sort((a, b) => (a.rect.top - b.rect.top) * 1000000 + (a.rect.left - b.rect.left) * 100 + idx)
            return els[0].el
        }
        return null
    }

    /**
     * Utility to run an evaluation over all elements in a list.
     */
    evaluateAll<T>(elList: ElementHandle[], fn: (el: Element) => T) {
        return Promise.all(elList.map(el => el.evaluate(fn)))
    }

    /**
     * Retrieves the center of the element in window coordinates.
     * Optionally scrolls the element into view first, then gets the center.
     */
    getElementCenter(el: ElementHandle, scrollIntoView: boolean = false): Promise<Point> {
        if (scrollIntoView) {
            return this.scrollToElement(el)
        }
        return el.evaluate(el => {
            const rect = el.getBoundingClientRect()
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            }
        })
    }


    /**
     * Scrolls down one page-full.
     * @returns numnber of pixels actually scrolled, due to the height of the window and the amount of scroll distance remaining.
     */
    async pageDown() {
        return await this.page.evaluate(() => {
            let scrollY = window.scrollY
            window.scrollBy(0, window.innerHeight)
            return window.scrollY - scrollY
        })
    }

    /**
     * Scrolls such that the given point is as close to the center of the view as we can get it.
     * Does not bother if we're close enough already.
     */
    scrollToPoint(pt: Point): Promise<void> {
        try {
            this.statusPush(`Scrolling to ${pt.x},${pt.y}`)
            return this.page.evaluate(pt => {
                const viewHeight = window.innerHeight || document.documentElement.clientHeight
                const viewWidth = window.innerWidth || document.documentElement.clientWidth
                const yDelta = Math.round(pt.y - viewHeight / 2)
                const xDelta = Math.round(pt.x - viewWidth / 2)
                if (Math.abs(yDelta) > 10 || Math.abs(xDelta) > 10) {     // only bother if it's a non-trivial amount
                    window.scrollBy(xDelta, yDelta)
                }
            }, pt)
        } finally {
            this.statusPop(false)
        }
    }

    /**
     * Scrolls such that the given point is as close to the center of the view as we can get it.
     * Does not bother if we're close enough already.  Repeats if the page changes after the scroll.
     * Returns element position after the operation.
     */
    async scrollToElement(el: ElementHandle): Promise<Point> {
        let currPt = await this.getElementCenter(el, false)
        let prevPt: Point
        do {
            prevPt = currPt
            await this.scrollToPoint(prevPt)
            await this.wait(250, "foreground")      // settling
            currPt = await this.getElementCenter(el, false)        // reload the position
        } while (currPt.x != prevPt.x || currPt.y != prevPt.y);
        return currPt
    }

    /**
     * Simulates a mouse-click on a point in Window coordinates, with various options for how to simulate.
     */
    async clickOnElement(el: ElementHandle, options: ClickOptions = {}) {

        // Get the location of where to click, which is the element or after scrolling into view.
        let pt = await this.getElementCenter(el, options.scrollIntoView ?? true)

        // Move to the point
        this.statusPush(`Moving mouse to ${pt.x},${pt.y}`)
        await this.page.mouse.move(pt.x, pt.y, { steps: 5 })
        this.statusPop(false)

        // Refresh point and click on it
        this.statusPush(`Clicking on ${pt.x},${pt.y}`)     // reuse our status position
        pt = await this.getElementCenter(el)            // reload because things can shift
        await this.page.mouse.click(pt.x, pt.y, { delay: 200 })
        this.statusPop(false)

        // Wait after the click
        if (options.waitAfter !== 0) {
            await this.wait(options.waitAfter ?? 100, options.waitIn ?? "foreground")
        }
    }

    /**
     * Simulates typing inside an element.
     */
    async typeInElement(el: ElementHandle, text: string, options: TypeOptions) {
        // Scroll into view
        if (options.scrollIntoView ?? true) {
            await this.scrollToElement(el)
        }
        // Focus
        this.statusPush("Focusing")
        await el.focus()
        await this.wait(200)
        this.statusPop(false)
        // Type, by line since there's options based on line-endings
        // If we need to handle lines specially, do that, otherwise blast it out all at once.
        this.statusPush(`Typing ${text.length} characters`)
        const pupetteerOptions: KeyboardTypeOptions = { delay: (options.slowTyping ?? true) ? 5 : 0 }
        if (options.multiLinedShiftReturn) {
            for (let line of text.split('\n')) {
                line = line.trimEnd()
                if (line) {     // could be a blank line
                    await this.page.keyboard.type(line, pupetteerOptions)
                }
                await this.page.keyboard.down('Shift')
                await this.page.keyboard.press('Enter')
                await this.page.keyboard.up('Shift')
            }
        } else {
            await this.page.keyboard.type(text, pupetteerOptions)
        }
        if (options.pressReturnAtEnd) {
            await this.page.keyboard.press('Enter')
        }
        this.statusPop(false)
        // Wait
        const waitMs = options.waitAfter ?? 100
        const waitIn = options.waitIn ?? "foreground"
        if (waitMs > 0) {
            await this.wait(waitMs, waitIn)
        }
    }

    /**
     * Press and release the "escape" key in this page.
     */
    async pressEscape() {
        await this.page.keyboard.press('Escape')
    }

    /**
     * Acquire the active-page mutex, and become the active page
     */
    private async acquireActivePage() {
        this.statusPush(`Waiting for active page`)
        await this.browser.activePageMutex.acquire()
        this.inForeground = true
        this.statusPop(false)
        await this.page.bringToFront()
    }

    /**
     * No longer have the active-page mutex.
     */
    private releaseActivePage() {
        this.inForeground = false
        this.browser.activePageMutex.release()
    }

}