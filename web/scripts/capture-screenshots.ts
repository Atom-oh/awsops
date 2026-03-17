import { chromium, type Page, type Browser } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const BASE_URL = 'https://awsops.whchoi.net/awsops';
const LOGIN_EMAIL = 'admin@awsops.local';
const LOGIN_PASSWORD = '!234Qwer';
const OUTPUT_DIR = path.join(__dirname, '..', 'static', 'screenshots');

interface PageCapture {
  category: string;
  name: string;
  path: string;
  waitSelector?: string;
}

const pages: PageCapture[] = [
  // Overview
  { category: 'overview', name: 'dashboard', path: '/' },
  { category: 'overview', name: 'ai-assistant', path: '/ai' },
  { category: 'overview', name: 'agentcore', path: '/agentcore' },
  // Compute
  { category: 'compute', name: 'ec2', path: '/ec2' },
  { category: 'compute', name: 'lambda', path: '/lambda' },
  { category: 'compute', name: 'ecs', path: '/ecs' },
  { category: 'compute', name: 'ecr', path: '/ecr' },
  { category: 'compute', name: 'eks', path: '/k8s' },
  { category: 'compute', name: 'eks-explorer', path: '/k8s/explorer' },
  { category: 'compute', name: 'eks-pods', path: '/k8s/pods' },
  { category: 'compute', name: 'eks-nodes', path: '/k8s/nodes' },
  { category: 'compute', name: 'eks-deployments', path: '/k8s/deployments' },
  { category: 'compute', name: 'eks-services', path: '/k8s/services' },
  { category: 'compute', name: 'container-cost', path: '/container-cost' },
  { category: 'compute', name: 'eks-container-cost', path: '/eks-container-cost' },
  // Network & CDN
  { category: 'network', name: 'vpc', path: '/vpc' },
  { category: 'network', name: 'cloudfront', path: '/cloudfront-cdn' },
  { category: 'network', name: 'waf', path: '/waf' },
  { category: 'network', name: 'topology', path: '/topology' },
  // Storage & DB
  { category: 'storage', name: 'ebs', path: '/ebs' },
  { category: 'storage', name: 's3', path: '/s3' },
  { category: 'storage', name: 'rds', path: '/rds' },
  { category: 'storage', name: 'dynamodb', path: '/dynamodb' },
  { category: 'storage', name: 'elasticache', path: '/elasticache' },
  { category: 'storage', name: 'opensearch', path: '/opensearch' },
  { category: 'storage', name: 'msk', path: '/msk' },
  // Monitoring
  { category: 'monitoring', name: 'monitoring', path: '/monitoring' },
  { category: 'monitoring', name: 'cloudwatch', path: '/cloudwatch' },
  { category: 'monitoring', name: 'cloudtrail', path: '/cloudtrail' },
  { category: 'monitoring', name: 'cost', path: '/cost' },
  { category: 'monitoring', name: 'inventory', path: '/inventory' },
  // Security
  { category: 'security', name: 'iam', path: '/iam' },
  { category: 'security', name: 'security', path: '/security' },
  { category: 'security', name: 'compliance', path: '/compliance' },
];

async function login(page: Page): Promise<void> {
  console.log('Navigating to login page...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for page to fully load including Cognito redirect
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // If redirected to Cognito hosted UI
  if (currentUrl.includes('amazoncognito.com') || currentUrl.includes('auth.')) {
    console.log('Cognito hosted UI detected, filling credentials...');

    // Wait for the form element to exist in DOM (not necessarily visible)
    await page.waitForSelector('#signInFormUsername', { state: 'attached', timeout: 30000 });

    // Debug: capture login page and check element state
    await page.screenshot({ path: path.join(OUTPUT_DIR, '_cognito-login.png'), fullPage: true });
    const formInfo = await page.evaluate(() => {
      const el = document.getElementById('signInFormUsername') as HTMLInputElement;
      if (!el) return 'Element not found';
      const style = window.getComputedStyle(el);
      return JSON.stringify({
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        offsetWidth: el.offsetWidth,
        offsetHeight: el.offsetHeight,
        type: el.type,
        parentDisplay: el.parentElement ? window.getComputedStyle(el.parentElement).display : 'none',
      });
    });
    console.log(`Form element state: ${formInfo}`);

    // Use JavaScript to directly set values and submit (bypasses CSS visibility)
    await page.evaluate(({ email, password }) => {
      const usernameEl = document.getElementById('signInFormUsername') as HTMLInputElement;
      const passwordEl = document.getElementById('signInFormPassword') as HTMLInputElement;

      if (usernameEl) {
        usernameEl.value = email;
        usernameEl.dispatchEvent(new Event('input', { bubbles: true }));
        usernameEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordEl) {
        passwordEl.value = password;
        passwordEl.dispatchEvent(new Event('input', { bubbles: true }));
        passwordEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    // Click submit via JS as well
    await page.evaluate(() => {
      const submitBtn = document.querySelector('input[name="signInSubmitButton"]') as HTMLInputElement;
      if (submitBtn) {
        submitBtn.click();
      } else {
        // Fallback: submit the form directly
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.submit();
      }
    });

    // Wait for redirect back to app
    await page.waitForURL('**/awsops/**', { timeout: 60000 });
    console.log('Login successful, redirected to app.');
  } else {
    console.log('Already logged in or no Cognito redirect.');
  }

  await page.waitForTimeout(5000);
}

async function captureScreenshot(page: Page, capture: PageCapture): Promise<void> {
  const url = `${BASE_URL}${capture.path}`;
  const dir = path.join(OUTPUT_DIR, capture.category);

  fs.mkdirSync(dir, { recursive: true });

  console.log(`Capturing: ${capture.category}/${capture.name} (${url})`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for charts and data to render
    await page.waitForTimeout(3000);

    if (capture.waitSelector) {
      await page.waitForSelector(capture.waitSelector, { timeout: 10000 }).catch(() => {});
    }

    // Viewport screenshot
    await page.screenshot({
      path: path.join(dir, `${capture.name}.png`),
      fullPage: false,
    });

    // Full page screenshot
    await page.screenshot({
      path: path.join(dir, `${capture.name}-full.png`),
      fullPage: true,
    });

    console.log(`  Done: ${capture.category}/${capture.name}`);
  } catch (err) {
    console.error(`  Error capturing ${capture.category}/${capture.name}:`, err);
  }
}

async function main(): Promise<void> {
  console.log('Starting screenshot capture...');
  console.log(`Output directory: ${OUTPUT_DIR}`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    await login(page);

    for (const capture of pages) {
      await captureScreenshot(page, capture);
    }

    console.log(`\nAll screenshots captured to ${OUTPUT_DIR}`);
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await browser.close();
  }
}

main();
