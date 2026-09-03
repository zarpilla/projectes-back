'use strict';

/**
 * Builds the v5 content-type + component registry from the schema.json files.
 * Used by the ETL to know every table, its scalar columns and relation attrs.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');

function loadRegistry() {
  const contentTypes = []; // { apiName, uid, table, attributes }
  const apisDir = path.join(ROOT, 'src/api');
  for (const apiName of fs.readdirSync(apisDir)) {
    const ctDir = path.join(apisDir, apiName, 'content-types');
    if (!fs.existsSync(ctDir)) continue;
    for (const ctName of fs.readdirSync(ctDir)) {
      const schemaPath = path.join(ctDir, ctName, 'schema.json');
      if (!fs.existsSync(schemaPath)) continue;
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      contentTypes.push({
        apiName,
        ctName,
        uid: `api::${apiName}.${ctName}`,
        table: schema.collectionName,
        kind: schema.kind,
        attributes: schema.attributes || {},
      });
    }
  }

  const components = [];
  const compsDir = path.join(ROOT, 'src/components');
  for (const group of fs.readdirSync(compsDir)) {
    const gDir = path.join(compsDir, group);
    if (!fs.statSync(gDir).isDirectory()) continue;
    for (const f of fs.readdirSync(gDir)) {
      if (!f.endsWith('.json')) continue;
      const schema = JSON.parse(fs.readFileSync(path.join(gDir, f), 'utf8'));
      components.push({
        compName: `${group}.${path.basename(f, '.json')}`,
        table: schema.collectionName,
        attributes: schema.attributes || {},
      });
    }
  }

  return { contentTypes, components };
}

module.exports = { loadRegistry };
