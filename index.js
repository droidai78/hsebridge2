
// index.js - CORS-enabled HSE Bridge

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(express.json());

// Enable CORS for all origins (for testing - restrict later if needed)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const PORT = 3000;

console.log("\n----------------------------------");
console.log("🚀 HSE Bridge running on port", PORT);
console.log("----------------------------------\n");

app.post("/hse-summary", async (req, res) => {
  try {
    const { incident_number } = req.body;
    if (!incident_number) {
      return res.status(400).json({ error: "incident_number missing" });
    }

    console.log("Request for incident_number:", incident_number);

    const sn_url = `${process.env.SN_INSTANCE}/api/now/table/incident?sysparm_query=number=${incident_number}&sysparm_limit=1&sysparm_display_value=true`;
    console.log("Calling ServiceNow URL:", sn_url);

    const response = await fetch(sn_url, {
      headers: {
        "Accept": "application/json",
        "Authorization": "Basic " + Buffer.from(process.env.SN_USERNAME + ":" + process.env.SN_PASSWORD).toString("base64")
      }
    });

    console.log("ServiceNow status:", response.status);

    if (!response.ok) {
      return res.status(response.status).json({ error: `ServiceNow error: ${response.status}` });
    }

    const json = await response.json();
    const record = json.result && json.result[0];
    if (!record) {
      return res.status(404).json({ error: "Incident not found" });
    }

    // Example summary
    const summary = `Incident ${incident_number}: ${record.short_description || "No description"} (Priority ${record.priority || "N/A"})`;
    res.json({ summary });

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("HSE Bridge ready at http://localhost:" + PORT);
});
