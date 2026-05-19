/**
 * ============================================================
 * AMC Cinemas – Showtime Scraper
 * 
 * Powered by: Node.js + puppeteer-extra + stealth plugin
 * 
 * Description: 
 * Automates the extraction of showtimes from AMC's dynamic 
 * Uses Puppeteer's Stealth plugin to reliably bypass 
 * blocked programmatic AJAX requests to the /getallmovies API.
 * ============================================================
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ── Configuration ─────────────────────────────────────────────
const TARGET_URL = "https://www.amccinemas.com/showtime";
const TARGET_CITY = "Jeddah";
const PAGE_LOAD_TIMEOUT = 60_000; // ms
const HEADLESS = "new"; // Use "new" for headless mode, false for debugging UI
// ──────────────────────────────────────────────────────────────

// ── Wait for page content ─────────────────────────────────────
async function waitForContent(page) {
    // 1. Wait for loader to be displayed
    await new Promise(r => setTimeout(r, 2000));

    // 2. Wait for loader to hide
    try {
        await page.waitForFunction(() => {
            const overlay = document.querySelector(".loader-overlay");
            return !overlay || window.getComputedStyle(overlay).display === "none";
        }, { timeout: PAGE_LOAD_TIMEOUT });
    } catch {
        console.warn("[AMC] ⚠ Loader hide timeout");
    }

    // 3. Wait for the multifilter section to have content
    try {
        await page.waitForFunction(() => {
            const el = document.getElementById('multifilter');
            if (!el) return false;
            const html = el.innerHTML;
            if (html.includes('inner-page-loader')) return false;
            return html.trim().length > 100;
        }, { timeout: PAGE_LOAD_TIMEOUT });
    } catch {
        console.warn("[AMC] ⚠ Movie content load timeout in #multifilter");
    }

    await new Promise(r => setTimeout(r, 1000));
}

// ── Apply city filter via JS ──────────────────────────────────
async function filterCity(page) {
    // We must wait for Sel_date to have options first, otherwise FilterByAudienceExperience fails
    try {
        await page.waitForFunction(() => {
            const s = document.getElementById('Sel_date');
            return s && s.options && s.options.length > 0 && s.options[0].value !== '';
        }, { timeout: PAGE_LOAD_TIMEOUT });
    } catch {
        console.warn("[AMC] ⚠ Dates never loaded in Sel_date dropdown");
    }

    const result = await page.evaluate((targetCity) => {
        const sel = document.getElementById('Sel_cinema');
        if (!sel) return 'ERR:NOT_FOUND';

        let changed = false;
        let n = 0;
        for (const opt of sel.options) {
            const match = opt.text.toLowerCase().includes(targetCity.toLowerCase());
            if (match) n++;
            if (opt.selected !== match) {
                opt.selected = match;
                changed = true;
            }
        }
        if (!n) return 'ERR:NO_MATCH:' + [...sel.options].map(o => o.text).join('|');

        if (changed) {
            try { $(sel).selectpicker('refresh'); } catch (e) { }
            try { FilterByAudienceExperience(); } catch (e) { return 'ERR:FN:' + e.message; }
        }
        return 'OK:' + n;
    }, TARGET_CITY);

    console.log(`[AMC] City filter: ${result}`);
    await new Promise(r => setTimeout(r, 2500));
}

// ── Get movie list from the Movies dropdown ───────────────────
async function getMovieList(page) {
    return await page.evaluate(() => {
        const sel = document.getElementById('Sel_films');
        if (!sel) return [];
        return [...sel.options].filter(o => o.value).map(o => ({ name: o.text.trim(), value: o.value }));
    });
}

// ── Select a specific movie via its filter dropdown ───────────
async function filterMovie(page, movieValue) {
    const result = await page.evaluate((val) => {
        const sel = document.getElementById('Sel_films');
        if (!sel) return 'ERR:NOT_FOUND';

        let changed = false;
        for (const opt of sel.options) {
            const match = (opt.value === val);
            if (opt.selected !== match) {
                opt.selected = match;
                changed = true;
            }
        }

        if (changed) {
            try { $(sel).selectpicker('refresh'); } catch (e) { }
            try { FilterByAudienceExperience(); } catch (e) { return 'ERR:FN:' + e.message; }
        }
        return 'OK';
    }, movieValue);
    await new Promise(r => setTimeout(r, 2000));
    return result;
}

// ── Scrape the current accordion state ───────────────────────
async function scrapeCurrentView(page, movieTitle) {
    // We execute the scraping inside the page context since Puppeteer is robust enough
    return await page.evaluate((mTitle) => {
        const rows = [];

        function makeId(cinema, movie, exp, time) {
            return `${cinema}-${movie}-${exp}-${time}`.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        }

        const movieSections = document.querySelectorAll(".amc-movie-details-left");

        if (movieSections.length > 0) {
            for (const section of movieSections) {
                let currentMovieTitle = mTitle;
                if (currentMovieTitle === "Unknown Movie") {
                    const hTitle = section.querySelector("h1, h2.amc-movie-title, h2");
                    if (hTitle) currentMovieTitle = hTitle.textContent.trim();
                }

                const panels = section.querySelectorAll(".panel.panel-default, section.panel, div.panel");

                for (const panel of panels) {
                    // Skip mobile view to avoid duplicates
                    if (panel.closest('.mobile-view') || panel.closest('.amc-mobile-view')) continue;
                    let cinemaName = "AMC Cinemas";
                    const aCinema = panel.querySelector('.panel-heading a, .panel-title a, h2 a');
                    if (aCinema) {
                        const clone = aCinema.cloneNode(true);
                        const dist = clone.querySelector('.amc-distance, .amc-miles');
                        if (dist) dist.remove();
                        cinemaName = clone.textContent.trim();
                    }

                    const groups = panel.querySelectorAll(".amc-experience-group, section.individual-genre");

                    if (groups.length > 0) {
                        for (const group of groups) {
                            let experience = "Standard";
                            const expLabel = group.querySelector(".amc-experience-title, .amc-exp-title");
                            if (expLabel && expLabel.textContent.trim()) {
                                experience = expLabel.textContent.trim();
                            }

                            const links = group.querySelectorAll("ul.amc-time-list li a, .amc-btn-time");
                            for (const link of links) {
                                let time = "";
                                const tSpan = link.querySelector("span.amc-time");
                                if (tSpan) time = tSpan.textContent.trim();
                                else time = link.textContent.trim();

                                // Skip empty times
                                if (!time) continue;

                                let url = link.getAttribute("href") || "";
                                if (url && !url.startsWith("http") && !url.startsWith("javascript")) {
                                    url = "https://www.amccinemas.com" + url;
                                } else if (!url || url.startsWith("javascript")) {
                                    const sid = link.getAttribute("data-showtime-id");
                                    if (sid) url = "https://www.amccinemas.com/booking/" + sid;
                                }

                                rows.push({
                                    id: makeId(cinemaName, currentMovieTitle, experience, time),
                                    movieTitle: currentMovieTitle,
                                    cinemaName: cinemaName,
                                    experience: experience,
                                    city: "Jeddah",
                                    startTime: time,
                                    totalSeats: -1, freeSeats: -1, fullnessPercent: -1,
                                    bookingLink: url, scrapedAt: new Date().toISOString(), source: "amccinemas"
                                });
                            }
                        }
                    } else {
                        // Flat fallback
                        const links = panel.querySelectorAll("ul.amc-time-list li a, .amc-btn-time");
                        for (const link of links) {
                            let time = link.textContent.trim();
                            if (!time) continue;

                            let url = link.getAttribute("href") || "";
                            if (url && !url.startsWith("http") && !url.startsWith("javascript")) {
                                url = "https://www.amccinemas.com" + url;
                            } else if (!url || url.startsWith("javascript")) {
                                const sid = link.getAttribute("data-showtime-id");
                                if (sid) url = "https://www.amccinemas.com/booking/" + sid;
                            }

                            rows.push({
                                id: makeId(cinemaName, currentMovieTitle, "Standard", time),
                                movieTitle: currentMovieTitle,
                                cinemaName: cinemaName,
                                experience: "Standard",
                                city: "Jeddah",
                                startTime: time,
                                totalSeats: -1, freeSeats: -1, fullnessPercent: -1,
                                bookingLink: url, scrapedAt: new Date().toISOString(), source: "amccinemas"
                            });
                        }
                    }
                }
            }
        }
        return rows;
    }, movieTitle);
}

// ── Main scrape ───────────────────────────────────────────────
async function scrapeAMC() {
    console.log(`[AMC] Starting Puppeteer Stealth...`);
    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1400,900'
        ]
    });
    const page = await browser.newPage();

    // Geolocation mock
    await page.evaluateOnNewDocument(() => {
        navigator.geolocation.getCurrentPosition = (success, error) => {
            setTimeout(() => success({ coords: { latitude: 21.5433, longitude: 39.1728, accuracy: 100 } }), 100);
        };
        navigator.geolocation.watchPosition = () => { };
        navigator.geolocation.clearWatch = () => { };
    });

    const results = [];

    try {
        console.log(`[AMC] Opening ${TARGET_URL}…`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });

        console.log("[AMC] Waiting for page content…");
        await waitForContent(page);

        // Wait for the city to be selected and the AJAX spinner to resolve
        console.log(`[AMC] Filtering to ${TARGET_CITY}…`);
        await filterCity(page);
        await waitForContent(page);

        // Get the list of movies from the Movies dropdown
        const movies = await getMovieList(page);
        console.log(`[AMC] Found ${movies.length} movie(s) in filter.`);

        if (movies.length === 0) {
            // No movie filter — scrape whatever is shown (all movies at once)
            console.log("[AMC] No movie filter found — scraping all visible showtimes.");
            const rows = await scrapeCurrentView(page, "Unknown Movie");
            results.push(...rows);
        } else {
            // Iterate over each movie
            for (const movie of movies) {
                if (!movie.value) continue;
                console.log(`[AMC] Scraping: "${movie.name}"…`);
                await filterMovie(page, movie.value);
                await waitForContent(page);

                // Check if the site explicitly says there are no showtimes
                const noShowtimes = await page.evaluate(() => {
                    const el = document.getElementById('multifilter');
                    return el && (el.textContent.includes('Sorry there are no showtimes available') || el.textContent.includes('no showtimes available'));
                });

                if (noShowtimes) {
                    console.log(`[AMC]   → Skipped (No showtimes available)`);
                    continue;
                }

                const rows = await scrapeCurrentView(page, movie.name);

                if (rows.length === 0) {
                    console.log(`[AMC]   → 0 showtime(s)`);
                } else {
                    const times = rows.map(r => `${r.experience} ${r.startTime}`.trim()).filter(t => t).join(', ');
                    console.log(`[AMC]   → ${rows.length} showtime(s) ${times ? '(' + times + ')' : ''}`);
                }

                results.push(...rows);
            }
        }

        console.log(`\n[AMC] ✓ Total showtimes scraped: ${results.length}`);

    } catch (err) {
        console.error("[AMC] ✗ Fatal error:", err.message);
        console.error(err.stack);
    } finally {
        if (!HEADLESS) {
            console.log("[AMC] Keeping browser open 30s for inspection…");
            await new Promise(r => setTimeout(r, 30000));
        }
        await browser.close();
    }

    return results;
}

// ── Standalone runner ─────────────────────────────────────────
if (require.main === module) {
    scrapeAMC().then((data) => {
        console.log("\n── Sample output (first 3) ──");
        console.log(JSON.stringify(data.slice(0, 3), null, 2));
        console.log(`\nTotal showtimes scraped: ${data.length}`);
    });
}

module.exports = { scrapeAMC };