// Public discovery schema structure captured 2026-09-11; descriptions omitted.
export default {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
    },
    "title": {
      "type": "string",
    },
    "description": {
      "type": "string",
    },
    "patch": {
      "minItems": 1,
      "maxItems": 50,
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "replace",
              },
              "old_string": {
                "type": "string",
                "minLength": 1,
              },
              "new_string": {
                "type": "string",
              },
              "replace_all": {
                "type": "boolean",
              },
            },
            "required": [
              "op",
              "old_string",
              "new_string",
            ],
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "insert_before",
              },
              "anchor": {
                "type": "string",
                "minLength": 1,
              },
              "text": {
                "type": "string",
                "minLength": 1,
              },
            },
            "required": [
              "op",
              "anchor",
              "text",
            ],
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "insert_after",
              },
              "anchor": {
                "type": "string",
                "minLength": 1,
              },
              "text": {
                "type": "string",
                "minLength": 1,
              },
            },
            "required": [
              "op",
              "anchor",
              "text",
            ],
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "prepend",
              },
              "text": {
                "type": "string",
                "minLength": 1,
              },
            },
            "required": [
              "op",
              "text",
            ],
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "append",
              },
              "text": {
                "type": "string",
                "minLength": 1,
              },
            },
            "required": [
              "op",
              "text",
            ],
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "const": "replace_range",
              },
              "from": {
                "type": "string",
                "minLength": 1,
              },
              "to": {
                "type": "string",
                "minLength": 1,
              },
              "new_string": {
                "type": "string",
              },
            },
            "required": [
              "op",
              "from",
              "to",
              "new_string",
            ],
          },
        ],
      },
    },
    "team": {
      "type": "string",
    },
    "template": {
      "type": "string",
    },
    "cycle": {
      "type": [
        "string",
        "null",
      ],
    },
    "milestone": {
      "type": "string",
    },
    "priority": {
      "type": "number",
    },
    "project": {
      "type": [
        "string",
        "null",
      ],
    },
    "state": {
      "type": "string",
    },
    "assignee": {
      "type": [
        "string",
        "null",
      ],
    },
    "delegate": {
      "type": [
        "string",
        "null",
      ],
    },
    "labels": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "addLabels": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "removeLabels": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "dueDate": {
      "type": [
        "string",
        "null",
      ],
    },
    "slaBreachesAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern":
            "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        },
        {
          "type": "null",
        },
      ],
    },
    "slaType": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "all",
            "onlyBusinessDays",
          ],
        },
        {
          "type": "null",
        },
      ],
    },
    "parentId": {
      "type": [
        "string",
        "null",
      ],
    },
    "estimate": {
      "type": [
        "number",
        "null",
      ],
    },
    "links": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "format": "uri",
          },
          "title": {
            "type": "string",
            "minLength": 1,
          },
        },
        "required": [
          "url",
          "title",
        ],
      },
    },
    "setReleases": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "addReleases": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "removeReleases": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "blocks": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "blockedBy": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "relatedTo": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "duplicateOf": {
      "type": [
        "string",
        "null",
      ],
    },
    "removeBlocks": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "removeBlockedBy": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
    "removeRelatedTo": {
      "type": "array",
      "items": {
        "type": "string",
      },
    },
  },
  "additionalProperties": false,
};
