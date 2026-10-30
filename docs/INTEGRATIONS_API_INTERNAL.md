# API d'integració: notes internes

Per a l'equip d'ESSTrapis. El document per a les sòcies i els seus desenvolupadors és [INTEGRATIONS_API.md](INTEGRATIONS_API.md): s'hi pot enviar tal com està, sense aquestes notes.

- **Codi:**
  - `src/api/integration`: rutes, controlador i serveis `contacts-sync`, `orders-sync`, `route-assignment`, `lookups` i `sync-common`;
  - `src/policies/api-key.js`: la policy que valida la clau;
  - `src/services/integrations`: `api-keys` i `refs`.
- **Dades:**
  - Content types `api::integration.api-key` (taula `api_keys`) i `api::integration.integration-ref` (taula `integration_refs`), amagats del panell d'administració.
  - L'índex únic `(owner_id, kind, external_id)` el crea `ensureRefsIndex` a cada arrencada.
  - `integration_refs.requested_date` guarda el dia que va demanar la sòcia, quan la comanda ha anat a un dia de ruta posterior.
- **Regles:** l'API no duplica les normes, sinó que fa servir les de l'aplicació:
  - `memberRules`, exportades de `middlewares/app-permissions.js`;
  - `orderRules`, exportades de `api/order/controllers/order.js`;
  - els lifecycles de les comandes.
- **Sòcia i historial:** la policy deixa la sòcia a `ctx.state.integration`. El controlador la posa a `ctx.state.user` com a «Nom (API)», perquè l'historial de la comanda la registri.
- **Registre:** cada petició deixa una línia `[integrations]` al log (Loki), amb l'usuària, el prefix de la clau, els recomptes i la durada.

## Claus d'API

- Les crea i les revoca l'oficina, a Administració › Usuàries › (la sòcia) › Claus d'API. Aquest bloc només surt si la usuària té el permís Logística.
- Rutes d'administració (JWT + `isAdmin`): `GET /api/integrations/api-keys?user=<id>`, `POST /api/integrations/api-keys` (`{ user, name }`, torna la clau un sol cop) i `DELETE /api/integrations/api-keys/:id` (la revoca; la fila es conserva).
- Format `esk_` + 43 caràcters. Es desen el SHA-256 i el prefix (`esk_` + 8 caràcters) per reconèixer-la a la pantalla.
