# ESSTRAPIS backend

The API of **ESSTRAPIS**, management software for cooperatives, associations and other organisations of the Social and Solidarity Economy (ESS, *Economia Social i Solidària*).

This repository is the backend, built on [Strapi 5](https://strapi.io). The web application that people use is in [projectes-front](https://github.com/zarpilla/projectes-front).

- Website: https://esstrapis.org
- Frontend: https://github.com/zarpilla/projectes-front
- Previous backend (Strapi 3, deprecated): https://github.com/zarpilla/projectes

## What is ESSTRAPIS?

ESSTRAPIS brings the day-to-day management of an organisation into one place: its projects, the hours each person puts into them, and the money that comes in and goes out. Everything revolves around the project, so that at any moment you can see whether it is going as budgeted: what was expected to be earned, spent and worked, and what actually was.

| Area | What it covers |
| ---- | -------------- |
| **Projects** | Projects with phases and budgets, parent and child projects, planning (Gantt), tasks, contacts, quotes |
| **Time** | Hours per person, task and project, workday log, hour balance, festives, payroll and advances |
| **Money** | Issued and received invoices, expenses, diets and tickets, VAT, treasury and forecasts |
| **E-invoicing** | [VERI\*FACTU](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu.html) records and electronic invoices to the public administration through FACe |
| **Grants** | Economic status of each grant and its justifications |
| **Logistics** | Orders, pickup points, routes and incidences, for the organisations that deliver goods |
| **Data** | Pivot tables and charts, CSV export, and this API |

ESSTRAPIS is used by cooperatives such as Resilience Earth, Arran de Terra, La Diligència, Raiels, L'Arada and Núria Social. Each organisation runs as its own tenant, with its own database.

## Stack

- Strapi 5 on Node 20
- MySQL
- Jest for tests

## Getting started

You need Node 20 (`nvm use` reads `.nvmrc`) and a MySQL database.

```bash
npm install

# settings: server, secrets, database, email
cp .env.example .env

# Strapi in develop mode, with the admin panel at http://localhost:1337/admin
npm run dev
```

Then run the [frontend](https://github.com/zarpilla/projectes-front) with `VUE_APP_API_URL` pointing at this server.

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Strapi with auto-reload |
| `npm run build` | Build the admin panel |
| `npm start` | Strapi without auto-reload (production) |
| `npm test` | All tests in `tests/` |
| `npm test -- tests/<file>.test.js` | One test file |
| `npm run lint` | ESLint |

## Project layout

| Path | Contents |
| ---- | -------- |
| `src/api/` | Content types with their controllers, services and lifecycles |
| `src/services/` | Shared services and run-once startup scripts that repair data |
| `config/` | Strapi configuration, including the cron jobs |
| `tests/` | Jest tests. They stub `global.strapi` and don't boot Strapi |
| `deploy/` | Server scripts for the Docker deployment |
| `tools/` | The ETL and tooling used to migrate from Strapi 3 |

## Documentation

| Question | Doc |
| -------- | --- |
| How do I write a query, and which access layer do I use? | [docs/DATA_ACCESS_CONVENTIONS.md](docs/DATA_ACCESS_CONVENTIONS.md) |
| How do I ship to the tenants? | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| A screen is blank or a value is missing after the migration | [docs/V3_TO_V5_TRAPS.md](docs/V3_TO_V5_TRAPS.md) |
| How did the Strapi 3 to 5 migration go? | [MIGRATION.md](MIGRATION.md) |
| Conventions for tests and data repairs | [AGENTS.md](AGENTS.md) |

## Deployment

One Docker image serves every tenant; tenant settings come from the environment. A push to `main` runs the tests, builds the image and deploys it. Changes to docs, `deploy/` and Markdown files don't trigger a build. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Contributing

Every bug fix or feature should come with a test that fails before the change and passes after it. Issues are tracked at https://tiquets.esstrapis.org.
