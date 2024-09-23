import { homedir } from 'os'
import * as path from 'path'
import { Browser, launch, Page } from 'puppeteer';
import { Mutex } from 'async-mutex';
import { Task, TaskConstructor, TaskRunner, TaskRunnerConstructor, TaskUpdateFunction } from '@asmartbear/jobs';
import { GoOptions, PuppyteerPage } from './page';

/**
 * Options when creating a new `Puppyteer`.
 */
export type BrowserOptions<Tags extends string> = {
    headless: boolean,
    width?: number,
    height?: number,

    /**
     * The Chrome profile to use.  If not provided, uses the system default.
     * The '~' is allowed, and is resolved to the user's home directory.
     */
    profilePath?: string,

    /**
     * Options for the task-runner.
     */
    taskRunner: TaskRunnerConstructor<Tags>,

    /**
     * If true, log all activity to the console, not just in status messages
     */
    logActivity?: boolean,
}

/**
 * Options when creating a new `Task`.
 */
export type TaskOptions<Tags extends string> = TaskConstructor<Tags> & {
    /**
     * If given, start by navigating to this URL in the background.
     * Because it's in the background, this loads faster than waiting for the foreground.
     */
    url?: string,

    /**
     * Options to be passed to `page.goto()` when we go to that URL in the background.
     */
    goOptions?: GoOptions,
}

/**
 * Information given to a PuppyteerPage.
 */
export type PageInfo<Tags extends string> = TaskOptions<Tags> & {
    /**
     * Status-update method.
     */
    fStatus: TaskUpdateFunction,
}

/**
 * Information given to a task when it's running.
 */
export type TaskInfo<Tags extends string> = PageInfo<Tags> & {
    /**
     * The page to operate on.
     */
    page: PuppyteerPage,
}

/**
 * Resolves things like "~"
 * @param path the path to resolve
 */
function resolvePath(p: string): string {
    if (p && p[0] == '~') {
        return path.join(homedir(), p.slice(1));
    }
    return p
}

/**
 * Controls the one browser instance, as well as the pages and jobs
 * that will run inside the browser.  Browsers aren't actually created
 * until it is needed.
 */
export class Puppyteer<Tags extends string> {
    public readonly width: number
    public readonly height: number
    public readonly headless: boolean
    public readonly profilePath: string | undefined
    public readonly logActivity: boolean

    /**
     * The living browser instance, if one was created.
     */
    private _browser: Browser | null = null

    /**
     * Pages available to be reused.
     */
    private readonly availablePages: Page[] = []

    /**
     * The browser-mutex protecting a variety of things in a single-threaded mode.
     */
    public readonly browserMutex = new Mutex()

    /**
     * The mutex protecting work that is happening on a the (active) page.
     */
    public readonly activePageMutex = new Mutex()

    /**
     * The task-runner for things running in this browser.
     */
    public readonly taskRunner

    /**
     * The currently active page, if any.
     */
    public activePage: Page | null = null

    constructor(options: BrowserOptions<Tags>) {
        this.headless = options.headless
        this.width = options.width || 1000
        this.height = options.height || 1000
        this.profilePath = options.profilePath ? resolvePath(options.profilePath) : undefined
        this.taskRunner = new TaskRunner<Tags>(options.taskRunner)
        this.logActivity = options.logActivity || false
    }

    /**
     * Creates and returns the browser instance if it hasn't already been created.
     * Fancy return type because N-1 invocations don't need to wait in fact!
     */
    private create(): Promise<Browser> | Browser {
        // Don't do it twice. This is so common, we should check before getting the mutex.
        if (this._browser) return this._browser

        return this.browserMutex.runExclusive(async () => {
            if (this._browser) return this._browser     // race condition when we open many pages right at the start

            // Launch the browser
            const browser = await launch({
                headless: this.headless,
                userDataDir: this.profilePath,
                args: [
                    `--window-size=${this.width},${this.height}`,
                    `--hide-crash-restore-bubble`,    // don't show the "Chrome didn't shut down correctly" bubble
                    `--no-default-browser-check`,
                    `--no-sandbox`,
                    '--max-old-space-size=4096',
                    `--disable-sync`,
                    `--mute-audio`,
                    `--disable-extensions`,
                    `--disable-features=Translate`,
                    `--disable-setuid-sandbox`,
                    '--disable-dev-shm-usage',
                    // `--single-process`,
                    this.headless ? '--disable-gl-drawing-for-tests' : '',
                ],
                protocolTimeout: 2000,      // typically 180_000!
            });

            // Accumulate any pages it created into our available list
            this.availablePages.push(...await browser.pages())
            const page: Page | undefined = this.availablePages[0]

            // If not headless, set up the viewport
            if (page && !this.headless) {
                await page.setViewport({
                    width: this.width - 20,      // scrollbars
                    height: this.height - 200,       // the header
                })
            }

            // Set up
            this._browser = browser
            return browser
        })
    }

    /**
     * Closes the browser, if it was open.  The object can be reused after this.
     */
    async close() {
        if (this._browser) {
            await this._browser.close()
            this._browser = null;
        }
        this.availablePages.length = 0
    }

    /**
     * Gets a new page in the browser, creating one if needed, or reusing one if possible.
     */
    async getPage(): Promise<Page> {

        // If a page is available, use it
        let page = this.availablePages.pop()
        if (!page) {
            // Create the page
            const browser = await this.create()      // ensure browser exists
            page = this.availablePages.pop()        // that might have created a page
            if (!page) {
                page = await browser.newPage()
            }
            this.activePage = null        // don't assume who is active now
        }
        return page
    }

    /**
     * Called by `page.Close()` to say that it is finished.
     */
    acceptClosedPage(page: Page) {
        this.availablePages.push(page)
    }

    /**
     * Waits for a given number of milliseconds, as a promise.
     * Use `0` to yield.
     * Does not release any mutex, so be careful using this.
     */
    wait(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Adds a task which operates on a browser page that is managed
     * outside of the task, and runs some operations only with a mutex with the page active.
     * Returns the new Task object, which could be used for control or dependencies.
     */
    addPageTask(config: TaskOptions<Tags>, executionFunction: (info: TaskInfo<string>) => Promise<void>): Task<Tags> {
        return this.taskRunner.addTask(config, async (fStatus) => {

            // Create the page
            const page = await this.getPage()     // grab the page only when the task starts
            const pageInfo = {
                ...config,
                fStatus,
            }
            const pPage = new PuppyteerPage(this, page, pageInfo)

            try {
                // Go to the URL while we're still in the background
                if (config.url) {
                    await pPage.goto(config.url, config.goOptions ?? {})
                }

                // Run the task in the foreground
                await pPage.runInForeground(executionFunction)

            } catch (err) {
                console.error(err)
                throw err
            } finally {
                this.acceptClosedPage(page)
            }
        })
    }
}

