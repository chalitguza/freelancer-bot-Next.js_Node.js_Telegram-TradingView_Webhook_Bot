const Telegram = require("telegraf/telegram");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

const { sequelize, defaultRows, Message, Setting } = require("./models");

/**
 * A function that update's the worker activity status in Database
 */
async function updateWorkerStatus(initial = false) {
  if (initial === true) {
    return await Setting.findOrCreate({
      where: { type: "worker" },
      defaults: { data: new Date().toISOString() },
    });
  }

  await Setting.update(
    { data: new Date().toISOString() },
    { where: { type: "worker" } }
  );
}

/**
 * A function that will obtain the URL of a screenshot generated by TradingView.
 *
 * @param {class} page - A puppeteer page instance
 * @param {object} options - Options used while taking a screenshot
 *
 * @returns {string} - The screenshot Image URL
 */
async function screenshot(page, { symbol, timeframe }) {
  // Symbol URL
  let url = `https://www.tradingview.com/symbols/${symbol}/`;

  const [exchange, stock] = symbol.split(":");
  if (exchange && stock) {
    url = `https://www.tradingview.com/symbols/${stock}/?exchange=${exchange}`;
  }

  // Go to symbol page
  await page.goto(url);
  await page.waitForSelector('a[href*="/chart/?"]');
  const graph_url = await page.evaluate(
    () => document.querySelector('a[href*="/chart/?"]').href
  );

  // Go to graph page
  await page.goto(graph_url);
  await page.waitForSelector(".menu-1fA401bY");
  await page.click(".menu-1fA401bY");
  await page.waitForSelector(".item-2xPVYue0");
  await page.evaluate((timeframe) => {
    document.querySelectorAll(".item-2xPVYue0").forEach((tag) => {
      if (tag.textContent !== timeframe) return;

      tag.click();
    });
  }, timeframe);

  // Wait for image generation
  await page.waitForSelector("[class='chart-loading-screen']");
  await page.click("#header-toolbar-screenshot");
  await page.waitForSelector('[value*="https://www.tradingview.com/x/"]');

  // Get image URL
  const image_url = await page.evaluate(() => {
    return document.querySelector('[value*="https://www.tradingview.com/x/"]')
      .value;
  });

  return image_url;
}

/**
 * A worker that is called periodically to dispatch messages.
 *
 * @param {class} page - A puppeteer page instance
 */
async function processQueue(page) {
  // Update worker status
  await updateWorkerStatus();

  const bot_settings = await Setting.findOne({
    where: { type: "telegram:bot" },
  });
  const screenshot_settings = await Setting.findOne({
    where: { type: "tradingview:screenshot" },
  });
  const pending_messages = await Message.findAll({
    where: { status: "pending" },
  });

  console.log(new Date(), "Pending messages:", pending_messages.length);

  const bot = new Telegram(bot_settings.data);

  // Iterate over all messages
  for (let i = 0; i < pending_messages.length; i++) {
    const message = pending_messages[i];
    const id = message["id"];
    const data = message["data"];
    const timeframe = message["timeframe"];
    const channels = message["channels"].split(",");
    const symbol = data.split(" ")[0];

    console.log(new Date(), "Processing Message ID:", id);

    // Iterate over all channels
    for (let j = 0; j < channels.length; j++) {
      const channel = channels[j];
      let image = null;

      if (screenshot_settings.enabled) {
        try {
          image = await screenshot(page, {
            symbol,
            timeframe: timeframe || screenshot_settings.data,
          });
          console.log(new Date(), "Screenshot (SUCCESS):", symbol);
        } catch (err) {
          image =
            "https://miro.medium.com/max/978/1*pUEZd8z__1p-7ICIO1NZFA.png";

          // Update logs
          await Message.update({ log: JSON.stringify(err) }, { where: { id } });

          console.log(new Date(), "Screenshot (FAILED):", symbol);
        }

        // Update worker status
        await updateWorkerStatus();
      }

      // Dispatch messages
      try {
        let response;

        if (screenshot_settings.enabled) {
          response = await bot.sendPhoto(channel, image, { caption: data });
        } else {
          response = await bot.sendMessage(channel, data);
        }

        await Message.update(
          { status: "success", log: JSON.stringify(response) },
          { where: { id } }
        );

        console.log(new Date(), "Dispatch (SUCCESS):", channel);
      } catch (err) {
        // Update logs
        await Message.update(
          { status: "failed", log: JSON.stringify(err) },
          { where: { id } }
        );

        console.log(new Date(), "Dispatch (FAILED):", err);
      }

      // Update worker status
      await updateWorkerStatus();
    }
  }
}

/**
 * Init worker function
 */
async function init() {
  console.log(new Date(), "Worker started");

  /**********************
   * INITILIZE DATABASE *
   **********************/
  await sequelize.sync();
  await defaultRows();
  await updateWorkerStatus(true);

  /**********************
   * INITIALIZE BROWSER *
   **********************/
  puppeteer.use(StealthPlugin());

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--start-fullscreen", "--no-sandbox", "--window-size=1366,768"],
  });
  const page = (await browser.pages())[0];

  // Confirm leaving page without saving
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  console.log(new Date(), "Browser session opened");

  const credentials_settings = await Setting.findOne({
    where: { type: "tradingview:credentials" },
  });

  /********************
   * LOGIN TO ACCOUNT *
   ********************/
  if (credentials_settings.enabled) {
    try {
      const [email, password] = credentials_settings.data.split(":");

      await page.goto("https://www.tradingview.com/#signin");
      await page.click("span.js-show-email");
      await page.type('[name="username"]', email);
      await page.type('[name="password"]', password);
      await page.click('[type="submit"]');

      await Promise.race([
        page.waitForNavigation({ waitUntil: "networkidle0" }),
        page.waitForSelector(".tv-dialog__error"),
      ]);

      const failed = await page.evaluate(
        () => !!document.querySelector(".tv-dialog__error")
      );

      if (!failed) {
        console.log(new Date(), "Login (SUCCESS):", credentials_settings.data);
      } else {
        console.log(new Date(), "Login (INVALID):", credentials_settings.data);
      }
    } catch (err) {
      console.log(new Date(), "Login (FAILED):", err);
    }
  }

  /********************
   * PROCESS MESSAGES *
   ********************/
  while (true) {
    // Update worker stats
    console.log(new Date(), "Checking Queue");

    try {
      // Process Queue
      await processQueue(page);
    } catch (err) {
      console.log(new Date(), "Process Queue (FAILED):", err);
    }

    const wait = 1; // seconds
    console.log(new Date(), `Recheck Queue in: ${wait} seconds`);

    // Sleep
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

init();
