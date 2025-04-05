require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { DateTime, Interval } = require('luxon');

puppeteer.use(StealthPlugin());

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isWithinUKWorkHours() {
    const now = DateTime.utc().setZone('Europe/London');
    const isWeekday = now.weekday >= 1 && now.weekday <= 5;
    const workHours = Interval.fromDateTimes(
        now.set({ hour: 8, minute: 0 }),
        now.set({ hour: 16, minute: 0 })
    );
    return isWeekday && workHours.contains(now);
}

async function applyToJobs(page, searchQuery, location) {
    const jobsUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(searchQuery)}&location=${encodeURIComponent(location)}&geoId=101165590&f_JT=F%2CC&f_TPR=r86400&f_WT=2`;
    await page.goto(jobsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.base-card', { timeout: 10000 });

    const jobCards = await page.$$('.base-card');
    console.log(`📋 Found ${jobCards.length} jobs:`);

    for (let i = 0; i < jobCards.length; i++) {
        const cardText = await page.evaluate(el => el?.innerText || '', jobCards[i]);
        const isPromoted = cardText.includes('Promoted');
        const isApplied = cardText.includes('Applied');
        // Skip Promoted jobs
        if (isPromoted) {
            console.log(`⏭️ Skipping promoted job #${i + 1}`);
            continue;
        }
        // Skip Applied jobs
        if (isApplied) {
            console.log(`⏭️ Skipping already applied job #${i + 1}`);
            continue;
        }

        // Close "Sign in to view more jobs" popup if it appears
        try {
            const modalCloseBtn = await page.$('button[aria-label="Dismiss"]');
            if (modalCloseBtn) {
                await modalCloseBtn.click();
                console.log('🧹 Closed login modal popup');
                await page.waitForTimeout(1000);
            }
        } catch (err) {
            console.log('No modal found to close');
        }

        try {
            const title = await jobCards[i].$eval('.base-search-card__title', el => el.innerText.trim());
            const company = await jobCards[i].$eval('.base-search-card__subtitle', el => el.innerText.trim());
            const location = await jobCards[i].$eval('.job-search-card__location', el => el.innerText.trim());
            const posted = await jobCards[i].$eval('time', el => el.innerText.trim());

            console.log(`🎯 Applying to ${i + 1}. ${title} @ ${company} (${location}) — ${posted}`);

            await jobCards[i].hover();
            await delay(500);
            await jobCards[i].click();
            await delay(1500);

            const sidebarLoaded = await page.waitForFunction(() => {
                const sidebar = document.querySelector('.jobs-search__job-details--container');
                return sidebar && sidebar.offsetHeight > 0;
            }, { timeout: 8000 }).catch(() => false);

            if (!sidebarLoaded) {
                console.log(`⚠️ Skipping job #${i + 1} — sidebar details failed to load`);
                continue;
            }
            await delay(randomInt(2000, 4000));

            const easyApplyBtn = await page.$('button.jobs-apply-button');
            if (!easyApplyBtn) {
                console.log(`⏭️ Skipping job #${i + 1} — not Easy Apply`);
                continue;
            }

            await easyApplyBtn.click();
            await delay(randomInt(2000, 4000));

            let steps = 0;
            while (true) {
                const emailSelect = await page.$('select[aria-required="true"]');
                if (emailSelect) {
                    await page.select('select[aria-required="true"]', process.env.LINKEDIN_EMAIL);
                    console.log(`📧 Selected email: ${process.env.LINKEDIN_EMAIL}`);
                }

                const phoneCountrySelect = await page.$('select[id*="phoneNumber-country"]');
                if (phoneCountrySelect) {
                    await page.select('select[id*="phoneNumber-country"]', 'United Kingdom (+44)');
                    console.log(`🌍 Selected country code`);
                }

                const phoneInput = await page.$('input[aria-describedby*="phoneNumber-nationalNumber-error"]');
                if (phoneInput) {
                    await phoneInput.click({ clickCount: 3 });
                    await phoneInput.type(process.env.LINKEDIN_PHONE);
                    console.log('📱 Filled in phone number');
                }

                const nextBtn = await page.$('button[data-easy-apply-next-button]');
                const reviewBtn = await page.$x("//span[contains(text(), 'Review')]//ancestor::button");
                const submitBtn = await page.$('button[aria-label="Submit application"]');

                if (submitBtn) {
                    await submitBtn.click();
                    console.log(`✅ Submitted job #${i + 1}`);
                    await delay(2000);
                    break;
                } else if (reviewBtn.length > 0) {
                    await reviewBtn[0].click();
                    await delay(2000);
                    console.log(`📝 Clicked Review button`);
                } else if (nextBtn) {
                    await nextBtn.click();
                    await delay(2000);
                    console.log(`➡️ Step ${++steps}: clicked Next`);
                } else {
                    console.log(`⚠️ No Next, Review, or Submit button found — possibly manual step required`);
                    break;
                }
            }

            try {
                const noThanksBtn = await page.$x("//button[contains(text(), 'No thanks')]");
                if (noThanksBtn.length > 0) {
                    await noThanksBtn[0].click();
                    console.log('👋 Dismissed app suggestion modal');
                }
            } catch (e) {
                console.log('No app suggestion modal to dismiss');
            }
        } catch (err) {
            console.log(`❌ Error on job #${i + 1}: ${err.message}`);
        }
    }
}

(async () => {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({
        width: 1280,
        height: 800
    });

    // Login
    await page.goto('https://www.linkedin.com/login');
    await page.type('#username', process.env.LINKEDIN_EMAIL);
    await page.type('#password', process.env.LINKEDIN_PASSWORD);
    await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    console.log('🔐 Logged in (Stealth + Desktop)');

    const searchTerms = ['Java', 'Reactjs', 'Full Stack Developer'];
    const location = 'United Kingdom';

    while (true) {
        if (isWithinUKWorkHours()) {
            const term = searchTerms[randomInt(0, searchTerms.length - 1)];
            console.log(`\n🔄 Running job search: "${term}"`);
            await applyToJobs(page, term, location);

            const nextDelay = randomInt(30, 60) * 60 * 1000;
            console.log(`⏳ Waiting ${nextDelay / 60000} minutes...\n`);
            await delay(nextDelay);
        } else {
            console.log('⏰ Outside UK work hours (Mon–Fri, 8AM–4PM), checking again in 30 minutes...');
            await delay(30 * 60 * 1000);
        }
    }

    // await browser.close();
})();