require("dotenv").config();
const awsServerlessExpressMiddleware = require("aws-serverless-express/middleware");
const express = require("express");
const mondaySdk = require("monday-sdk-js");
const axios = require("axios").default;
const throttle = require("promise-ratelimit")(20000);

// Init
const app = express();
const monday = mondaySdk();
monday.setToken(process.env.monday_key);

// MIDDLEWARE
// Only run in Production
if (process.env.NODE_ENV !== "development") {
  app.use(awsServerlessExpressMiddleware.eventContext());
  app.use((req, res, next) => {
    req.body = req.apiGateway.event.body;
    next();
  });
}
// Always run
app.use(express.json());

// SET UP INTERCEPTORS
let limit = false;
axios.interceptors.request.use(async (config) => {
  config.headers["Authorization"] = `Bearer ${process.env.pope_tech_key}`;
  return config;
});
axios.interceptors.response.use(undefined, async (error) => {
  if (error.response.status === 429) {
    await throttle();
    return axios(error.config);
  }
  return Promise.reject(error);
});

// TEST ROUTE
app.get("/hello", (req, res) => {
  res.json("hello world");
});

// MAIN ROUTE
app.post("/groups", async (req, res) => {
  // RETURN CHALLANGE
  if (req.body.hasOwnProperty("challenge")) {
    console.log("Responding to webhook challenge");
    return res.status(200).json(req.body);
  }
  const id = req.body.event.pulseId;
  try {
    // SET BOARD TO LOADING
    await monday.api(`
    mutation {
      change_simple_column_value(item_id: ${id}, board_id: ${process.env.BOARD_ID}, column_id: "status5", value: "0") {
        id
      }
    }
    `);
    // GET MONDAY SITE DATA
    const response = await monday.api(`query {
          items(ids: [${id}]) {
            id
            name
            column_values (ids: ["text"]) { text }
          }
      }
      `);
    const domain = response.data.items[0].column_values[0].text;
    // GET POPETECH SITE DATA
    const siteData = await axios.get(
      `https://api.pope.tech/organizations/usu/websites?search=${domain}`
    );
    // END IF SITE DOESN'T EXIST
    if (siteData.data.data.length === 0) {
      return res.status(404).json("Site not found");
    }
    let groupName = siteData.data.data[0].group_name;
    const publicId = siteData.data.data[0].public_id;
    // GET SCAN DATA
    const websiteScanByPublicId = await axios.get(
      `https://api.pope.tech/organizations/usu/scans?website_filter=${publicId}&limit=1&status=success`
    );
    const scanId = websiteScanByPublicId.data.data[0].public_id;
    // GET ERROR DATA
    const fullErrorData = await axios.get(
      `https://api.pope.tech/organizations/usu/scans/${scanId}`
    );
    const errors = fullErrorData.data.data.totals[0].totals;
    const errorData = {
      totalErrors: errors.errors + errors.contrast,
      pages: errors.pages,
    };
    // SET ERROR DATA ON MONDAY
    await monday.api(`
      mutation {
        change_multiple_column_values(item_id: ${id}, board_id: ${process.env.BOARD_ID}, column_values: \"{ \\\"pt_errors0\\\": \\\"${errorData.totalErrors}\\\", \\\"pt_pages\\\":\\\"${errorData.pages}\\\" }\") {
          id
        }
      }
    `);
    // GET GROUP DATA
    const groupData = await axios.get(
      "https://api.pope.tech/organizations/usu/groups"
    );
    // FIND GROUP TREE
    let done = false;
    let groupTree = [];
    while (!done) {
      let found = findValue(groupData.data.data.tree, groupName);
      if (found) {
        groupTree.unshift(found.name);
        if (found.parent_name === "USU") {
          done = true;
        } else {
          groupName = found.parent_name;
        }
      } else {
        done = true;
      }
    }
    // SET GROUP DATA ON MONDAY
    const IDS = ["text63", "text5", "text81"];
    await monday.api(`
      mutation {
        change_multiple_column_values(item_id: ${id}, board_id: ${process.env.BOARD_ID}, column_values: \"{ \\\"${IDS[0]}\\\": \\\"\\\", \\\"${IDS[1]}\\\":\\\"\\\", \\\"${IDS[2]}\\\":\\\"\\\" }\") {
          id
        }
      }
    `);
    groupTree.forEach(async (group, idx) => {
      const res = await monday.api(`
      mutation {
        change_simple_column_value(item_id:${id}, board_id:${process.env.BOARD_ID}, column_id:"${IDS[idx]}", value:"${group}") {
          id
        } 
      }
      `);
    });
    await monday.api(`
    mutation {
      change_simple_column_value(item_id: ${id}, board_id: ${process.env.BOARD_ID}, column_id: "status5", value: "1") {
        id
      }
    }
    `);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    await monday.api(`
    mutation {
      change_simple_column_value(item_id: ${id}, board_id: ${process.env.BOARD_ID}, column_id: "status5", value: "2") {
        id
      }
    }
    `);
    res.sendStatus(500);
  }
});

let findValue = (arr, val) => {
  for (let obj of arr) {
    if (obj.name === val) {
      return obj;
    }
    if (obj.children) {
      let result = findValue(obj.children, val);
      if (result) {
        return result;
      }
    }
  }
  return undefined;
};

module.exports = app;
