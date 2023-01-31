import fs from 'fs/promises'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer'
import { isNil } from 'ramda'
import { v4 as uuidv4 } from 'uuid'
import dataset from './dataset.json'

(async () => {
  const browser = await puppeteer.launch({ headless: true, timeout: (1000 * 60) * 5 })
  const datasetLength = dataset.length

  type Batch = Article[]
  interface Article {
    link: string
    headline: string
    category: string
    short_description: string
    authors: string
    date: string
  }

  // Batch in groups of 10 tabs so we don't hurt huffpost
  const batches: Batch[] = []
  let batch: Article[] = []
  for (let i = 0; i <= datasetLength; i++) {
    if (i % 10 === 0 || i === datasetLength) {
      if (i > 0 || i === datasetLength) batches.push(batch)
      batch = []
    }

    batch.push(dataset[i])
  }

  await fs.rm('./out', { recursive: true, force: true }).catch()
  await fs.mkdir('./out')

  // Open 10 tabs, get data, close, open 10 tabs
  for (const batch of batches) {
    const articles = batch.filter(article => !article.link.startsWith('https://www.huffingtonpost.comhttp')) // filter out bad data from dataset :(
    if (articles.length < batch.length) console.log(`Lost ${batch.length - articles.length} articles because of bad link`)

    const pages = articles.map(async (article: Article): Promise<Page> => await createTab(browser, article.link))

    console.log('Load article tabs')
    const tabs = await Promise.all(pages)
    console.log('Done')

    for (const tab of tabs) {
      const bodyTextContentElementHandlers = await tab.$$('.cli-text')
      const bodyImageAltElementHandler = await tab.$('.cli-image img')
      const bodyHeaderTextElementHandler = await tab.$('h1.headline')
      const bodyHeaderTextSubtitleElementHandler = await tab.$('div.dek')

      const bodyText = (await Promise.all(bodyTextContentElementHandlers.map(async elementHandle => await elementHandle.evaluate(el => {
        if (el.textContent === null) return
        if (el.textContent === '') return
        return el.textContent
      })))).filter(textNode => !isNil(textNode)) as string[] // Casting because TS still sees (string | undefined)[]

      const bodyImageAltText = await bodyImageAltElementHandler?.evaluate(el => {
        if (el.alt === '') return
        return el.alt
      })

      const bodyHeaderText = await bodyHeaderTextElementHandler?.evaluate(el => {
        if (el.textContent === '') return
        return el.textContent
      })

      const bodyHeaderTextSubtitle = await bodyHeaderTextSubtitleElementHandler?.evaluate(el => {
        if (el.textContent === '') return
        return el.textContent
      })

      await tab.close()
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      await fs.writeFile(`./out/${uuidv4()}.json`, JSON.stringify({
        bodyHeaderText,
        bodyHeaderTextSubtitle,
        bodyText,
        bodyImageAltText
      }, null, 2), 'utf-8')
    }
  }

  await browser.close()

  console.log({ dataset: dataset.length, batches: batches.length, batch: batches[0].length })
})()

async function createTab (
  browser: Browser,
  url: string
): Promise<Page> {
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', requestHandler)
  await page.goto(url)
  return page
}

function requestHandler (req: HTTPRequest): void {
  switch (req.resourceType()) {
    case 'image':
    case 'font':
    case 'media':
    case 'stylesheet':
      return void req.abort()
  }

  const rejPattern = [
    'googlesyndication.com',
    '/*.doubleclick.net',
    '/*.amazon-adsystem.com',
    '/*.adnxs.com'
  ]

  if (!isNil(rejPattern.find(pattern => req.url().match(pattern)))) {
    return void req.abort()
  }

  return void req.continue()
}
