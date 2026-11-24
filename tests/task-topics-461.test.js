'use strict';

/**
 * issues/461 (2026-11-24): «Temes de tasca». The task states were the only way
 * to group tasks, and the last one by order means "done", so an entity could
 * not turn them into areas without losing overdue and done. Joel (La
 * Diligència) asked for a second grouping: topics the admins rename and
 * create, one per task, to group the board and the list by.
 */

const path = require('path');

describe('task topics (issues/461)', () => {
  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    delete global.strapi;
  });

  it('is an optional many-to-one relation of the task', () => {
    const schema = require('../src/api/task/content-types/task/schema.json');
    expect(schema.attributes.task_topic).toEqual({
      type: 'relation',
      relation: 'manyToOne',
      target: 'api::task-topic.task-topic',
    });
    const topic = require('../src/api/task-topic/content-types/task-topic/schema.json');
    expect(Object.keys(topic.attributes)).toEqual(['name', 'order']);
  });

  it('is an auxiliary table for admins, labelled and sorted by order', async () => {
    global.strapi = {
      dirs: { app: { root: path.join(__dirname, '..') } },
      db: { query: () => ({ findOne: async () => ({ permissions: [{ permission: 'admin' }] }) }) },
    };
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const body = await controller.adminEntities({ state: { user: { id: 1 } } });
    const topic = body.entities.find((e) => e.name === 'task-topic');
    expect(topic).toBeTruthy();
    expect(topic.apiPath).toBe('task-topics');
    expect(topic.displayName).toBe('Temes de tasca');
    expect(topic.attributes.order.label).toBe('Ordre');
    expect(topic.attributes.name.help).toMatch(/temes/);
    expect(body.entityToApiPath['task-topic']).toBe('task-topics');
  });

  it('writes are kept for admins; everyone reads it', () => {
    const fs = require('fs');
    const router = fs.readFileSync(path.join(__dirname, '../src/api/task-topic/routes/task-topic.js'), 'utf8');
    for (const action of ['create', 'update', 'delete']) {
      expect(router).toMatch(new RegExp(`${action}: \\{ policies: \\['global::isAdmin'\\] \\}`));
    }
    const rules = fs.readFileSync(path.join(__dirname, '../src/services/app-access-rules.js'), 'utf8');
    expect(rules).toMatch(/'task-state',\n\s*'task-topic',/);
  });

  it('comes with the task on every read', async () => {
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, cfg) => {
          const ctl = cfg({ strapi: {} });
          Object.setPrototypeOf(ctl, { find: async (ctx) => ctx.query, findOne: async (ctx) => ctx.query });
          return ctl;
        },
      },
    }));
    const controller = require('../src/api/task/controllers/task');
    const listed = await controller.find({ query: {} });
    expect(listed.populate.task_topic).toBe(true);
    const one = await controller.findOne({ query: { populate: '*' }, params: { id: 3 } });
    expect(one.populate.task_topic).toBe(true);
  });

  it('the next occurrence of a recurring task keeps its topic', () => {
    const { nextTaskData } = require('../src/api/task/services/recurrence');
    const data = nextTaskData(
      { name: 'Revisar rutes', recurrence: 'weekly', due_date: '2026-11-24', task_topic: { id: 6 } },
      1,
      '2026-11-24',
    );
    expect(data.task_topic).toBe(6);
    expect(nextTaskData({ name: 'Sense', recurrence: 'weekly' }, 1, '2026-11-24').task_topic).toBeNull();
  });
});
