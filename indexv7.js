// index.js – HSE Bridge (Node.js + Express + ServiceNow + OpenAI)

require('dotenv').config();
const express = require('express');
const app = express();

// ---------- Basic middleware ----------
app.use(express.json());

// Simple CORS so AgilePoint (browser) can call this API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // for PoC; restrict in production
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Debug: check .env is loaded
console.log('SN_INSTANCE:', process.env.SN_INSTANCE);
console.log('SN_USERNAME:', process.env.SN_USERNAME);
console.log('SN_PASSWORD loaded:', !!process.env.SN_PASSWORD);
console.log('OPENAI_MODEL:', process.env.OPENAI_MODEL);
console.log('--------------------------------------');

// ---------- 1) Get item from ServiceNow ----------
async function getItemFromSN(number) {
  const pair = `${process.env.SN_USERNAME}:${process.env.SN_PASSWORD}`;
  const auth = Buffer.from(pair, 'ascii').toString('base64');

  const url =
    `${process.env.SN_INSTANCE}/api/now/table/sc_req_item` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_limit=1&sysparm_display_value=true`;
// asbstract 
  console.log('Calling ServiceNow URL:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  console.log('ServiceNow status:', res.status);
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`ServiceNow API error: ${res.status} – ${bodyText}`);
  }

  const data = JSON.parse(bodyText);
  if (!data.result || data.result.length === 0) {
    throw new Error('Item not found in ServiceNow');
  }

  return data.result[0];
}

// ---------- 1) Get incident from ServiceNow ----------
async function getIncidentFromSN(number) {
  const pair = `${process.env.SN_USERNAME}:${process.env.SN_PASSWORD}`;
  const auth = Buffer.from(pair, 'ascii').toString('base64');

  const url =
    `${process.env.SN_INSTANCE}/api/now/table/incident` +
    `?sysparm_query=number=${encodeURIComponent(number)}` +
    `&sysparm_limit=1&sysparm_display_value=true`;

  console.log('Calling ServiceNow URL:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  console.log('ServiceNow status:', res.status);
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`ServiceNow API error: ${res.status} – ${bodyText}`);
  }

  const data = JSON.parse(bodyText);
  if (!data.result || data.result.length === 0) {
    throw new Error('Incident not found in ServiceNow');
  }

  return data.result[0];
}

// ---------- 2) Ask OpenAI to summarize ----------
async function getItemSummaryFromOpenAI(item) {
  const text = `
Item number: ${item.number}
Short description: ${item.short_description}
Description: ${item.description}
Priority: ${item.priority}
State: ${item.state}
Item : ${item.configuration_item.display_value}
Quantity: ${item.quantity}
Linked Request: ${item.request.display_value}
Approval Status: ${item.approval}
Price: ${item.price}
Recurring Price: ${item.recurring_price}
Requested for: ${item.requested_for.display_value}


`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
          // make it more for fulfillers in servicenow
            'You are an HSE assistant summarizing health & safety items for HSE officers.',
        },
        {
          role: 'user',
          content:
          // make a more generic prompt
            `Summarize this item in 5–7 sentences, keeping the important aspects of the item and suggest a risk level and 3 recommended follow-up actions:\n${text}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} – ${bodyText}`);
  }

  const data = JSON.parse(bodyText);
  return data.choices[0].message.content;
}

async function getIncidentSummaryFromOpenAI(incident) {
  const text = `
Incident number: ${incident.number}
Short description: ${incident.short_description}
Description: ${incident.description}
Priority: ${incident.priority}
State: ${incident.state}
`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are an HSE assistant summarizing health & safety incidents for HSE officers.',
        },
        {
          role: 'user',
          content: `Please return a JSON object with two fields:

        1. "summary_and_risk": Format this as follows:
        **Incident Summary:**  
        [Provide a 5–7 sentence summary of the incident, including number, short description, priority, and any relevant context. Make it clear whether the incident poses any health, safety, or environmental risks.]

        **Risk Level:**  
        [State the risk level clearly as one of: Low, Medium, High]

        2. "followup_actions": Format this as follows:
        **Recommended Follow-up Actions:**  
        1. [First recommended action]  
        2. [Second recommended action]  
        3. [Third recommended action]

        Here is the incident data:\n${text}`
        },
      ],
      temperature: 0.2,
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} – ${bodyText}`);
  }

  let parsed;
  try {
    const data = JSON.parse(bodyText);
    parsed = JSON.parse(data.choices[0].message.content);
  } catch (err) {
    throw new Error(`Failed to parse OpenAI response as JSON: ${err.message}`);
  }

  return {
    summaryAndRiskLevel: parsed.summary_and_risk,
    followUpActions: parsed.followup_actions
  };
}


// ---------- 3) Main endpoint called by AgilePoint ----------
app.post('/hse-summary-item', async (req, res) => {
  try {
    const { item_number } = req.body;
    if (!item_number) {
      return res.status(400).json({ error: 'item_number is required' });
    }

    console.log('Request for item_number:', item_number);

    const item = await getItemFromSN(item_number);
    const summary = await getItemSummaryFromOpenAI(item);

    res.json({ item_number, summary });
  } catch (err) {
    console.error('ERROR IN /hse-summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/hse-summary-incident', async (req, res) => {
  try {
    const { incident_number } = req.body;
    if (!incident_number) {
      return res.status(400).json({ error: 'incident_number is required' });
    }

    console.log('Request for incident_number:', incident_number);

    const incident = await getIncidentFromSN(incident_number);
    const { summaryAndRiskLevel, followUpActions } = await getIncidentSummaryFromOpenAI(incident);

    res.json({
      incident_number,
      summary: summaryAndRiskLevel,
      follow_up: followUpActions
    });
  } catch (err) {
    console.error('ERROR IN /hse-summary-incident:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 4) Start server ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 HSE Bridge running on port ${port}`);
  console.log('--------------------------------------');
});
