// ============================================================
// 1. IMPORTS & TYPES
// ============================================================

import * as whoiser from 'whoiser';

export interface Env {
  GOOGLE_SAFE_BROWSING_API_KEY?: string;
   AI: any;
  // More bindings will go here (KV, AI, etc.)
}

// ============================================================
// 2. MAIN WORKER
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (['/api/health', '/health', '/'].includes(path)) {
      return jsonResponse({
        status: 'ok',
        message: 'CharityShield Worker is running!'
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Main API
    if (path === '/api/check' && request.method === 'POST') {
      return await handleCheck(request, env);
    }

    // 404
    return jsonResponse({ error: 'Not found' }, 404);
  }
};

// ============================================================
// 3. REQUEST HANDLER
// ============================================================

async function handleCheck(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { url: string };
    const targetUrl = body.url;

    if (!targetUrl) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }

    const fullUrl = normalizeUrl(targetUrl);
    let domain: string;
    try {
      domain = new URL(fullUrl).hostname;
    } catch {
      return jsonResponse({ error: 'Invalid URL format' }, 400);
    }

    // --- FETCH ALL PAGES ONCE ---
    const pagesData = await fetchAllPages(domain);

    // --- RUN ALL CHECKS IN PARALLEL ---
    // Helpers that don't need HTML: domain, ssl, reputation
    // Helpers that need HTML: online presence, registration, language
    const [domainAge, ssl, reputation, onlinePresence, charityRegistration, languageAnalysis] = await Promise.all([
      checkDomainAge(domain),
      checkSSL(domain),
      checkReputation(domain, env),
      checkOnlinePresence(pagesData.allHtml),
      checkCharityRegistration(pagesData.allHtml),
      checkLanguageAnalysis(pagesData.allHtml, env)    ]);

    // Build the checks array
    const checks = [
      domainAge,
      ssl,
      reputation,
      onlinePresence,
      charityRegistration,
      languageAnalysis
    ];

    // Return ONLY the data + checks
    return jsonResponse({
      url: fullUrl,
      domain: domain,
      checks: checks
    });

  } catch (error) {
    console.error('API Error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

// ============================================================
// 4. UTILITY FUNCTIONS
// ============================================================

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

function normalizeUrl(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  return url;
}

// ============================================================
// 4.5 FETCH ALL PAGES
// ============================================================

async function fetchAllPages(domain: string): Promise<{
  homepage: string;
  allHtml: string;
  pages: { url: string; html: string }[];
}> {
  const paths = [
    '',              // Homepage
    '/about',
    '/about-us',
    '/contact',
    '/contact-us',
    '/mission',
    '/donate',
    '/donation'
  ];

  const pages: { url: string; html: string }[] = [];
  let allHtml = '';

  for (const path of paths) {
    try {
      const url = `https://${domain}${path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const html = await response.text();
        pages.push({ url, html });
        allHtml += html + ' ';
      }
    } catch (error) {
      // Skip pages that don't exist
    }
  }

  const homepage = pages.length > 0 ? pages[0].html : '';

  return { homepage, allHtml, pages };
}

// ============================================================
// 5. HELPER FUNCTIONS - CHECKS
// ============================================================

// -----------------------------------------------------------------
// 5.1 DOMAIN AGE (WHOIS)
// -----------------------------------------------------------------
// Returns: { category, name, value, color, meaning, details }
// Colors: green (5+ years), yellow (1-5 years), orange (<1 year), red (<30 days), gray (unknown)
// -----------------------------------------------------------------

async function checkDomainAge(domain: string): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Domain',
    name: 'Domain Age',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not verify domain age',
    details: ''
  };

  try {
    const whoisData = await whoiser.whoisDomain(domain);

    const serverKeys = Object.keys(whoisData);
    if (serverKeys.length === 0) return defaultResult;

    const data = whoisData[serverKeys[0]];
    if (!data || typeof data !== 'object') return defaultResult;

    const createdDate = data['Created Date'] || data['Creation Date'] || '';
    if (!createdDate) return defaultResult;

    const created = new Date(createdDate);
    if (isNaN(created.getTime())) return defaultResult;

    const now = new Date();
    const ageMs = now.getTime() - created.getTime();
    const daysOld = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const yearsOld = Math.floor(ageMs / (1000 * 60 * 60 * 24 * 365));

    let value: string;
    if (yearsOld >= 1) {
      value = yearsOld + ' years';
    } else {
      const months = Math.floor(ageMs / (1000 * 60 * 60 * 24 * 30));
      value = months + ' months';
    }

    let color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
    let meaning: string;
    let details: string;

    if (daysOld < 30) {
      color = 'red';
      meaning = 'Very new domain - common in scams';
      details = `Registered on ${createdDate}`;
    } else if (yearsOld < 1) {
      color = 'orange';
      meaning = 'New domain - proceed with caution';
      details = `Registered on ${createdDate}`;
    } else if (yearsOld <= 5) {
      color = 'yellow';
      meaning = 'Moderately aged domain';
      details = `Registered on ${createdDate}`;
    } else {
      color = 'green';
      meaning = 'Well-established domain, good sign';
      details = `Registered on ${createdDate}`;
    }

    return {
      category: 'Domain',
      name: 'Domain Age',
      value: value,
      color: color,
      meaning: meaning,
      details: details
    };

  } catch (error) {
    console.error('WHOIS error:', error);
    return defaultResult;
  }
}

// -----------------------------------------------------------------
// 5.2 SSL CERTIFICATE
// -----------------------------------------------------------------
// Colors: green (valid), red (invalid/missing)
// -----------------------------------------------------------------

async function checkSSL(domain: string): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Security',
    name: 'SSL Certificate',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not verify SSL certificate',
    details: ''
  };

  try {
    const response = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });

    const isValid = response.ok || response.status < 500;

    let color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
    let value: string;
    let meaning: string;
    let details: string;

    if (isValid) {
      color = 'green';
      value = 'Valid';
      meaning = 'Website is secure';
      details = `Status: ${response.status}`;
    } else {
      color = 'red';
      value = 'Invalid';
      meaning = 'Website is not secure - do not enter any data';
      details = `Status: ${response.status}`;
    }

    return {
      category: 'Security',
      name: 'SSL Certificate',
      value: value,
      color: color,
      meaning: meaning,
      details: details
    };

  } catch (error) {
    console.error('SSL check error:', error);
    return {
      category: 'Security',
      name: 'SSL Certificate',
      value: 'Invalid',
      color: 'red',
      meaning: 'Website is not secure - could not establish HTTPS connection',
      details: error.message || 'Connection failed'
    };
  }
}

// -----------------------------------------------------------------
// 5.3 REPUTATION (Google Safe Browsing)
// -----------------------------------------------------------------
// Colors: green (clean), red (malicious/phishing), gray (unknown)
// -----------------------------------------------------------------

async function checkReputation(domain: string, env: Env): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Security',
    name: 'Safe Browsing',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not verify reputation',
    details: ''
  };

  try {
    const apiKey = env.GOOGLE_SAFE_BROWSING_API_KEY || '';
    if (!apiKey) {
      console.log('No API key for Google Safe Browsing');
      return defaultResult;
    }

    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: {
            clientId: 'charity-shield',
            clientVersion: '1.0.0'
          },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url: `https://${domain}` }]
          }
        }),
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) {
      console.error('Safe Browsing API error:', response.status);
      return defaultResult;
    }

    const data = await response.json();
    const hasMatches = data.matches && data.matches.length > 0;

    if (!hasMatches) {
      return {
        category: 'Security',
        name: 'Safe Browsing',
        value: 'Clean',
        color: 'green',
        meaning: 'No security issues detected',
        details: 'Not reported for malware or phishing'
      };
    }

    let malicious = false;
    let phishing = false;
    let spam = false;

    for (const match of data.matches) {
      const threatType = match.threatType;
      if (threatType === 'MALWARE' || threatType === 'POTENTIALLY_HARMFUL_APPLICATION') {
        malicious = true;
      }
      if (threatType === 'SOCIAL_ENGINEERING') {
        phishing = true;
      }
      if (threatType === 'UNWANTED_SOFTWARE') {
        spam = true;
      }
    }

    const issues = [];
    if (malicious) issues.push('Malware');
    if (phishing) issues.push('Phishing');
    if (spam) issues.push('Spam');

    return {
      category: 'Security',
      name: 'Safe Browsing',
      value: 'Issues Detected',
      color: 'red',
      meaning: 'Security issues detected - proceed with extreme caution',
      details: issues.join(', ')
    };

  } catch (error) {
    console.error('Reputation error:', error);
    return defaultResult;
  }
}

// -----------------------------------------------------------------
// 5.4 ONLINE PRESENCE (Contact Info + Social Media)
// -----------------------------------------------------------------
// Now accepts combined HTML from all pages
// Colors: green (address + contact), yellow (address only),
//         orange (no address but some contact), red (no presence)
// -----------------------------------------------------------------

async function checkOnlinePresence(html: string): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Presence',
    name: 'Online Presence',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not verify online presence',
    details: ''
  };

  if (!html || html.length === 0) {
    return {
      category: 'Presence',
      name: 'Online Presence',
      value: 'Unreachable',
      color: 'red',
      meaning: 'Website could not be reached',
      details: ''
    };
  }

  try {
    // --- CHECK CONTACT INFO ---
    let hasAddress = false;
    let hasPhone = false;
    let hasEmail = false;
    let address = '';
    let phone = '';
    let email = '';

    const addressPatterns = [
      /<p[^>]*>(.*?)(?:Address|地址|عنوان)[^<]*<\/p>/i,
      /<div[^>]*>(.*?)(?:Address|地址|عنوان)[^<]*<\/div>/i,
      /(?:Address|地址|عنوان):\s*(.*?)(?:\n|<\/|$)/i,
      /\d+\s+[A-Za-z]+\s+(?:Street|Avenue|Road|Boulevard|Drive|Lane|Way|St|Ave|Rd|Blvd|Dr|Ln)/i,
      /(?:P\.?O\.? Box|PO Box)\s+\d+/i
    ];

    for (const pattern of addressPatterns) {
      const match = html.match(pattern);
      if (match) {
        hasAddress = true;
        address = match[1] || match[0];
        address = address.replace(/<[^>]*>/g, '').trim();
        break;
      }
    }

    const phonePatterns = [
      /(?:Phone|Tel|电话|هاتف):\s*(.*?)(?:\n|<\/|$)/i,
      /[\+\d\s\-\(\)]{10,20}/g,
      /\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/g
    ];

    for (const pattern of phonePatterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) {
        hasPhone = true;
        phone = matches[0];
        if (phone.length > 3) break;
      }
    }

    const emailPatterns = [
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      /(?:Email|邮箱|البريد الإلكتروني):\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
    ];

    for (const pattern of emailPatterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) {
        hasEmail = true;
        email = matches[0];
        if (email.length > 3) break;
      }
    }

    if (address) address = address.replace(/\s+/g, ' ').trim();
    if (phone) phone = phone.replace(/\s+/g, ' ').trim();
    if (email) email = email.replace(/\s+/g, ' ').trim();

    // --- CHECK SOCIAL MEDIA ---
    const socialPatterns = {
      twitter: /twitter\.com\/[a-zA-Z0-9_]+/i,
      facebook: /facebook\.com\/[a-zA-Z0-9.]+/i,
      linkedin: /linkedin\.com\/(?:company|in)\/[a-zA-Z0-9-]+/i,
      instagram: /instagram\.com\/[a-zA-Z0-9_.]+/i
    };

    const socialResults = {
      twitter: socialPatterns.twitter.test(html),
      facebook: socialPatterns.facebook.test(html),
      linkedin: socialPatterns.linkedin.test(html),
      instagram: socialPatterns.instagram.test(html)
    };

    const activePlatforms: string[] = [];
    if (socialResults.twitter) activePlatforms.push('Twitter');
    if (socialResults.facebook) activePlatforms.push('Facebook');
    if (socialResults.linkedin) activePlatforms.push('LinkedIn');
    if (socialResults.instagram) activePlatforms.push('Instagram');

    // --- BUILD DETAILS ---
    const contactParts = [];
    if (hasAddress) contactParts.push('address');
    if (hasPhone) contactParts.push('phone');
    if (hasEmail) contactParts.push('email');
    const contactSummary = contactParts.length > 0 ? contactParts.join(', ') : 'none';
    const socialSummary = activePlatforms.length > 0 ? activePlatforms.join(', ') : 'none';
    const details = `Contact: ${contactSummary} | Social: ${socialSummary}`;

    // --- COLOR LOGIC ---
    if (hasAddress && (hasPhone || hasEmail)) {
      return {
        category: 'Presence',
        name: 'Online Presence',
        value: 'Complete',
        color: 'green',
        meaning: 'Physical address and contact information found',
        details: details
      };
    }

    if (hasAddress) {
      return {
        category: 'Presence',
        name: 'Online Presence',
        value: 'Address Only',
        color: 'yellow',
        meaning: 'Physical address found but no phone or email',
        details: details
      };
    }

    if (hasPhone || hasEmail) {
      return {
        category: 'Presence',
        name: 'Online Presence',
        value: 'Contact Only',
        color: 'orange',
        meaning: 'Contact info found but no physical address',
        details: details
      };
    }

    return {
      category: 'Presence',
      name: 'Online Presence',
      value: 'None',
      color: 'red',
      meaning: 'No contact information or address found - suspicious',
      details: details
    };

  } catch (error) {
    console.error('Online presence error:', error);
    return defaultResult;
  }
}

// -----------------------------------------------------------------
// 5.5 CHARITY REGISTRATION
// -----------------------------------------------------------------
// Now accepts combined HTML from all pages
// Colors: green (found), yellow (mentioned but no number), orange (not found)
// -----------------------------------------------------------------

async function checkCharityRegistration(html: string): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Registration',
    name: 'Charity Registration',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not verify charity registration',
    details: ''
  };

  if (!html || html.length === 0) {
    return {
      category: 'Registration',
      name: 'Charity Registration',
      value: 'Unreachable',
      color: 'gray',
      meaning: 'Could not check registration',
      details: ''
    };
  }

  try {
    let found = false;
    let number = '';
    let type = '';
    let value = '';
    let color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
    let meaning = '';
    let details = '';

    // US 501(c)(3)
    if (/501\(c\)\(3\)/i.test(html)) {
      found = true;
      type = '501(c)(3) (US)';
      number = '501(c)(3)';
      const einMatch = html.match(/EIN:\s*(\d{2}-\d{7})/i);
      if (einMatch) number = einMatch[1];
    }

    // UK Charity Commission
    if (!found) {
      const ukMatch = html.match(/registered\s+charity\s+number:\s*(\d{5,10})/i);
      if (ukMatch) {
        found = true;
        type = 'UK Charity Commission';
        number = ukMatch[1];
      }
    }

    // Canada Registration
    if (!found) {
      const caMatch = html.match(/(?:BN|Registration Number):\s*(\d{15})/i);
      if (caMatch) {
        found = true;
        type = 'Canada BN';
        number = caMatch[1];
      }
    }

    // General patterns
    if (!found) {
      const patterns = [
        /charity\s+number:\s*([A-Z0-9\-]+)/i,
        /registration\s+number:\s*([A-Z0-9\-]+)/i,
        /charity\s+no:\s*([A-Z0-9\-]+)/i,
        /رقم\s+التسجيل:\s*([A-Z0-9\-]+)/i,
        /رقم\s+الخيرية:\s*([A-Z0-9\-]+)/i
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          found = true;
          type = 'Charity Registration Number';
          number = match[1] || '';
          break;
        }
      }
    }

    const charityMention = /charity|nonprofit|non-profit|公益|خيرية/i.test(html);

    if (found && number) {
      color = 'green';
      value = 'Registered';
      meaning = 'Charity registration number found';
      details = `${type}: ${number}`;
    } else if (charityMention) {
      color = 'yellow';
      value = 'Mentioned';
      meaning = 'Charity mentioned but no registration number found';
      details = 'Website references charity but no registration number';
    } else {
      color = 'orange';
      value = 'Not Found';
      meaning = 'No charity registration found on website';
      details = 'No registration number or charity mention found';
    }

    return {
      category: 'Registration',
      name: 'Charity Registration',
      value: value,
      color: color,
      meaning: meaning,
      details: details
    };

  } catch (error) {
    console.error('Charity registration error:', error);
    return defaultResult;
  }
}

// -----------------------------------------------------------------
// 5.6 LANGUAGE ANALYSIS (AI-Powered)
// -----------------------------------------------------------------
// Uses Cloudflare Workers AI to analyze website language
// Colors: green (clean), yellow (mixed), orange (suspicious), red (critical)
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// 5.6 LANGUAGE ANALYSIS (AI-Powered - Scam Pattern Focused)
// -----------------------------------------------------------------

async function checkLanguageAnalysis(html: string, env: Env): Promise<{
  category: string;
  name: string;
  value: string;
  color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
  meaning: string;
  details: string;
}> {
  const defaultResult = {
    category: 'Content',
    name: 'Language Analysis',
    value: 'Unknown',
    color: 'gray' as const,
    meaning: 'Could not analyze language',
    details: ''
  };

  if (!html || html.length === 0) {
    return {
      category: 'Content',
      name: 'Language Analysis',
      value: 'Unreachable',
      color: 'gray',
      meaning: 'Could not analyze language',
      details: ''
    };
  }

  try {
    const text = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);

    if (!text || text.length < 50) {
      return {
        category: 'Content',
        name: 'Language Analysis',
        value: 'Insufficient Content',
        color: 'gray',
        meaning: 'Not enough content to analyze',
        details: ''
      };
    }

    // --- AI CALL ---
    const aiResponse = await env.AI.run(
      '@cf/meta/llama-3.2-3b-instruct',
      {
        prompt: `
You are a security analyst for a charity verification tool.

Analyze this charity website text.

Look ONLY for these specific scam patterns:

1. CRYPTO REQUESTS: Asks for cryptocurrency (Bitcoin, Ethereum, etc.)
2. GIFT CARD REQUESTS: Asks for gift cards (Steam, Apple, Amazon, Google Play)
3. UNUSUAL PAYMENT: Asks for wire transfer, Western Union, MoneyGram
4. PRESSURE TACTICS: "Send NOW or the offer expires", "Limited time only"
5. NO CLEAR INFORMATION: Avoids saying where donations go
6. NO CONTACT INFO: No address or phone

If you find ANY of these, mark as "Suspicious" with color "red".
If you find NONE of these, mark as "Legitimate" with color "green".

Return ONLY valid JSON:
{"color":"green","value":"Legitimate","meaning":"No scam patterns detected","details":"Normal charity website"}

OR

{"color":"red","value":"Suspicious","meaning":"Scam pattern detected: [specific pattern]","details":"[brief explanation]"}

Website text:
${text.substring(0, 2000)}
`
      }
    );

    // Parse AI response
    let result;
    try {
      const aiText = aiResponse.response || aiResponse;
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = JSON.parse(aiText);
      }
    } catch (parseError) {
      console.error('AI parse error:', parseError);
      return {
        category: 'Content',
        name: 'Language Analysis',
        value: 'Unknown',
        color: 'gray',
        meaning: 'Could not interpret AI response',
        details: ''
      };
    }

    const validColors = ['green', 'yellow', 'orange', 'red', 'gray'];
    const color = validColors.includes(result.color) ? result.color : 'gray';
    const value = result.value || 'Unknown';
    const meaning = result.meaning || 'Language analysis completed';
    const details = result.details || '';

    return {
      category: 'Content',
      name: 'Language Analysis',
      value: value,
      color: color as 'green' | 'yellow' | 'orange' | 'red' | 'gray',
      meaning: meaning,
      details: details
    };

  } catch (error) {
    console.error('Language analysis error:', error);
    return defaultResult;
  }
}