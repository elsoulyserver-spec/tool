___INFO___

{
  "type": "TAG",
  "id": "et_beacon_v1",
  "version": 1,
  "securityGroups": [],
  "displayName": "EasyTrac - Event Presence Beacon",
  "brand": {
    "displayName": "EasyTrac",
    "id": "brand_easytrac"
  },
  "description": "Fire-and-forget GET beacon to EasyTrac after each GA4 event. Populates event health diagnostics without storing raw event data. Filtered to known GA4 event names only.",
  "containerContexts": ["SERVER"]
}

___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "beaconUrl",
    "displayName": "EasyTrac Beacon Endpoint URL",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "clientId",
    "displayName": "EasyTrac Client ID (Firebase UID)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  },
  {
    "type": "TEXT",
    "name": "apiKey",
    "displayName": "EasyTrac API Key (eas_...)",
    "simpleValueType": true,
    "notSetText": "Required",
    "valueValidators": [{"type": "NON_EMPTY"}]
  }
]

___SANDBOXED_JS_FOR_SERVER___

var getAllEventData     = require('getAllEventData');
var encodeUriComponent = require('encodeUriComponent');
var sendHttpGet        = require('sendHttpGet');

var ALLOWED = {
  page_view: 1, view_item: 1, add_to_cart: 1, begin_checkout: 1,
  purchase: 1, generate_lead: 1, sign_up: 1, search: 1
};

var eventName = getAllEventData()['event_name'] || '';
if (!ALLOWED[eventName]) {
  data.gtmOnSuccess();
  return;
}

var url = data.beaconUrl
  + '?key='      + encodeUriComponent(data.apiKey)
  + '&clientId=' + encodeUriComponent(data.clientId)
  + '&event='    + encodeUriComponent(eventName);

// Fire-and-forget — beacon failure never blocks the event pipeline.
// Rate limiting and deduplication are handled server-side.
sendHttpGet(url, function() {}, {timeout: 2000});

data.gtmOnSuccess();

___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "send_http",
        "versionId": "1"
      },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "read_event_data",
        "versionId": "1"
      },
      "param": [
        {
          "key": "eventDataAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]

___TESTS___

[
  {
    "name": "Skips unknown event names",
    "code": "mock('getAllEventData', function() { return {event_name: 'login'}; }); runCode(data); assertApi('gtmOnSuccess').wasCalled(); assertApi('sendHttpGet').wasNotCalled();"
  },
  {
    "name": "Sends beacon for purchase",
    "code": "mock('getAllEventData', function() { return {event_name: 'purchase'}; }); mock('sendHttpGet', function(url, cb, opts) { cb(200); }); runCode(data); assertApi('gtmOnSuccess').wasCalled(); assertApi('sendHttpGet').wasCalled();"
  },
  {
    "name": "Sends beacon for page_view",
    "code": "mock('getAllEventData', function() { return {event_name: 'page_view'}; }); mock('sendHttpGet', function(url, cb, opts) { cb(200); }); runCode(data); assertApi('gtmOnSuccess').wasCalled();"
  }
]
