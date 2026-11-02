# API d'integració: punts d'entrega i comandes

Amb aquesta API, el programa de gestió d'una sòcia de la Diligència crea, actualitza i anul·la les seves comandes i punts d'entrega, sense haver de pujar fitxers CSV. Les comandes segueixen les mateixes normes que quan es fan des de l'aplicació.

- **Adreça base:** la mateixa de l'aplicació, acabada en `/api`. Entorn de proves: `https://ladili.esstrapis.org/api`.
- **Format:** JSON (`Content-Type: application/json`), UTF-8.
- **Autenticació:** capçalera `x-api-key` amb la clau que dona l'oficina.

## Autenticació

```
x-api-key: esk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

- L'oficina crea la clau a **Administració › Usuàries › (la sòcia) › Claus d'API**. Només es mostra un cop: s'ha de copiar en aquell moment i guardar en un lloc segur.
- La clau actua en nom de la sòcia. Només pot fer el que ella pot fer a l'aplicació.
- Una clau revocada deixa de funcionar a l'instant. Per canviar de clau: se'n crea una de nova, es canvia al programa i es revoca la vella.
- Límit: 60 peticions per minut per clau i 500 elements per petició.

| Resposta | Quan |
|---|---|
| `401` | Falta la clau, no és vàlida, està revocada o la usuària està bloquejada |
| `403` | La usuària no té el permís de comandes |
| `429` | Massa peticions en un minut |
| `400` | El cos no té la llista que toca, està buida o té més de 500 elements |

## Identificació: `external_id`

Cada comanda i cada punt d'entrega porta un `external_id`: el **seu identificador al vostre programa**, un text de fins a 191 caràcters.

- És únic per sòcia i per tipus. Si torneu a enviar el mateix `external_id`, s'actualitza el que ja existeix; mai no es crea un duplicat. Això val també si dues peticions arriben alhora.
- Enviar una comanda o un punt sense canvis no és un error: el resultat és `unchanged`. Podeu reenviar cada dia tota la llista de comandes obertes.
- Una comanda que deixa de sortir a la vostra llista **no** s'anul·la sola: cal anul·lar-la explícitament (`POST /integrations/orders/cancel`).

## Respostes de les escriptures

Les tres operacions d'escriptura responen **200** encara que alguns elements es rebutgin. Cada element és independent dels altres:

```json
{
  "request_id": "6f0c…",
  "dry_run": false,
  "summary": { "received": 3, "created": 1, "updated": 1, "linked": 0, "unchanged": 0,
               "cancelled": 0, "already_cancelled": 0, "not_found": 0, "rejected": 1 },
  "results": [
    { "index": 0, "external_id": "LD-1001", "result": "created", "order_id": 25330, "status": "pending",
      "route": { "id": 12, "name": "DC - BCN CIUTAT" }, "estimated_delivery_date": "2026-11-04",
      "price": 11.3, "late_order": false, "late_surcharge": 0, "transfer": true,
      "warnings": [{ "code": "DATE_MOVED", "message": "Cap ruta de Barcelona no surt el dimarts 03/11/2026: la comanda va el dimecres 04/11/2026 amb la ruta DC - BCN CIUTAT" }] },
    { "index": 1, "external_id": "LD-0990", "result": "updated", "order_id": 25101, "changed": ["kilograms"], "…": "…" },
    { "index": 2, "external_id": "LD-0950", "result": "rejected", "code": "ORDER_LOCKED",
      "message": "La comanda ja està Processada i no es pot modificar. Parla amb l'oficina.",
      "order_id": 24990, "status": "processed" }
  ]
}
```

- `result` pot ser: `created`, `updated`, `linked` (només punts d'entrega), `unchanged`, `cancelled`, `already_cancelled`, `not_found` o `rejected`.
- Quan és `rejected`, l'element porta un `code` estable (vegeu la taula del final) i un `message` en català per mostrar a qui fa servir el programa. Sovint també porta `field`, el camp que ha fallat.
- `warnings` porta els avisos d'un element que sí que s'ha desat (vegeu la taula d'avisos del final).
- **`dry_run: true`** al cos de la petició: es fan totes les comprovacions, però no es desa res. En una comanda, el preu que torna és una estimació, sense els descomptes per multientrega ni per volum (avís `PRICE_ESTIMATE`).

## Punts d'entrega: `PUT /integrations/contacts`

```json
{
  "contacts": [
    {
      "external_id": "CLI-0042",
      "name": "Queviures Maria Font SL",
      "trade_name": "Queviures Maria Font",
      "nif": "B12345678",
      "phone": "972 00 00 00",
      "email": "botiga@example.com",
      "address": "Carrer de la Font, 1",
      "postcode": "17001",
      "city": "Girona",
      "sector": "Súpers i Similars",
      "legal_form": "Empresa",
      "time_slot_1_ini": "9:00",
      "time_slot_1_end": 13,
      "time_slot_2_ini": null,
      "time_slot_2_end": null,
      "contact_person": "Maria",
      "contact_phone": "600 00 00 00",
      "notes": "Porta del darrere"
    }
  ]
}
```

- **`external_id` nou:**
  - Si ja teniu **un sol** punt amb el mateix NIF i el mateix nom comercial (sense distingir majúscules ni accents), s'hi enllaça i s'actualitza amb el que heu enviat. El resultat és `linked`. Serveix per enllaçar els punts que ja teníeu d'abans del CSV.
  - Si no en teniu cap, es crea un punt nou.
- **Per crear un punt calen:** `name` (o `trade_name`), `nif`, `phone`, `address`, `postcode`, `city`, `time_slot_1_ini` i `time_slot_1_end`.
- **`sector` i `legal_form` són opcionals.** Si en doneu un que no existeix, el punt es desa igualment sense aquell camp, amb l'avís `SECTOR_NOT_FOUND` o `LEGAL_FORM_NOT_FOUND`.
- **Població (`city`):** les comandes del punt van a les rutes que passen per aquesta població (vegeu «Ruta i dia» a les comandes). Si la població no té cap ruta, el punt es desa amb l'avís `TOWN_WITHOUT_ROUTES`, però no s'hi podran fer comandes fins que l'oficina n'hi posi una.
- **`external_id` que ja existeix:** només s'escriuen els camps que envieu. Els que no envieu es queden com estaven.
- **Horaris:** en hores, de 0 a 24, com a número (`9.5`) o com a text (`"9:30"`). Almenys una de les dues franges ha de ser de 3 hores o més. Si hi ha franja 2, cal l'hora d'inici i la de final.
- **`sector` i `legal_form`:** el nom o l'id. Els trobareu a `GET /integrations/catalog`.
- **Què no es pot canviar des de l'API:** els descomptes, la propietària ni les opcions de l'oficina. Un punt que l'oficina hagi passat a una altra sòcia queda `rejected` · `FORBIDDEN`.

## Comandes: `PUT /integrations/orders`

```json
{
  "orders": [
    {
      "external_id": "LD-1001",
      "estimated_delivery_date": "2026-11-03",
      "delivery_point": { "external_id": "CLI-0042" },
      "units": 2,
      "kilograms": 10.5,
      "refrigerated": false,
      "fragile": false,
      "pickup": "Artés",
      "provider_order_number": "0560605",
      "notes": "Trucar abans",
      "lines": [{ "units": 1, "kilograms": 4, "name": "Caixa A", "nif": "12345678Z" }]
    }
  ]
}
```

| Camp | Obligatori en crear | Notes |
|---|---|---|
| `external_id` | sí | El vostre identificador de la comanda |
| `delivery_point` | sí | `{ "external_id": … }` (un punt enviat per l'API), `{ "id": … }` o `{ "nif": …, "trade_name": … }` |
| `units` | sí | Caixes, enter > 0 |
| `kilograms` | sí | > 0, amb 2 decimals com a màxim |
| `estimated_delivery_date` | no | El dia que voleu l'entrega, `AAAA-MM-DD`, a partir de demà. Si no s'envia, el primer dia possible a partir de demà |
| `route` | no | Normalment no s'envia: la ruta l'assigna la Diligència (vegeu «Ruta i dia»). Si l'envieu (nom, nom curt o id), la data ha de ser un dia que aquesta ruta surti |
| `refrigerated` | no | `true`/`false`. Per defecte `false` |
| `fragile` | no | `true`/`false`. Per defecte `false` |
| `pickup` | no | Magatzem on es dipositen les caixes: nom, àlies o id. Si no s'envia, el magatzem per defecte de la sòcia |
| `provider_order_number` | no | Número de comanda que surt a l'albarà. Per defecte, l'`external_id` |
| `notes` | no | Observacions per a l'entrega |
| `lines` | no | Detall de caixes. S'envia sencer: substitueix el que hi havia |

**Ruta i dia:**

- Envieu el dia que voleu l'entrega. La Diligència hi assigna la ruta que passa per la població del punt d'entrega aquell dia. Si aquell dia no en passa cap, o la ruta està tancada, s'assigna el primer dia següent que en passi una. En aquest cas la resposta porta l'avís `DATE_MOVED`.
- Les rutes de cada població són les de «Poblacions i rutes». Si l'oficina tanca una ruta i en posa una d'alternativa, també es fa servir l'alternativa.
- La resposta diu quina ruta i quin dia s'han assignat (`route`, `estimated_delivery_date`).
- Si torneu a enviar el mateix dia que vau demanar, encara que s'hagués mogut, el resultat és `unchanged`. Si demaneu un altre dia, o canvieu el punt d'entrega a una altra població, la ruta i el dia s'assignen de nou.
- Una població sense cap ruta rep `TOWN_WITHOUT_ROUTES`.

**Normes:**

- **Data d'entrega:** ha de ser a partir de demà (`DATE_NOT_ALLOWED`). Si ja ha passat l'hora límit per a aquell dia, la comanda s'accepta igualment, marcada **fora de temps**, amb el recàrrec configurat i l'avís `LATE_ORDER` a `warnings`.
- **Preu:** el calcula sempre la Diligència: tarifa, descomptes per multientrega i per volum, i recàrrec. Una comanda nova pot fer canviar el descompte de les altres comandes del mateix dia. Per saber el preu definitiu, consulteu-lo amb `GET /integrations/orders`.
- **Modificacions:** només mentre la comanda està **pendent**. Només s'escriuen els camps que envieu.
  - Quan l'oficina ja l'ha agafada (processada, lliurada, facturada…), queda `ORDER_LOCKED`. En aquest cas cal parlar amb l'oficina.
  - Una comanda anul·lada no es torna a obrir (`ORDER_CANCELLED`): feu-ne una de nova amb un altre `external_id`.
  - Si les dades no canvien, el resultat és `unchanged` sigui quin sigui l'estat.
- **Si envieu `route`:** la data ha de ser un dia que la ruta surti i no estigui tancada (`DATE_NOT_ON_ROUTE`). Si canvieu la ruta sense data, la data que ja tenia la comanda ha de ser un dia de la ruta nova.
- **Recollides a finca:** no es poden fer des de l'API (`FARM_PICKUP_NOT_SUPPORTED`).

## Anul·lar comandes: `POST /integrations/orders/cancel`

```json
{ "orders": [{ "external_id": "LD-1001" }, { "external_id": "LD-1002" }] }
```

És el mateix que «Anul·la la comanda» a l'aplicació: només es poden anul·lar les comandes **pendents**. Quan l'oficina ja l'ha agafada (dipositada, processada, lliurada…), queda `ORDER_LOCKED`. Les comandes no s'esborren mai: queden anul·lades.

| `result` | Quan |
|---|---|
| `cancelled` | Era pendent i ara està anul·lada |
| `already_cancelled` | Ja estava anul·lada |
| `not_found` | No hi ha cap comanda vostra amb aquest `external_id` |
| `rejected` · `ORDER_LOCKED` | L'oficina ja l'ha agafada. Cal parlar amb l'oficina |

## Consultes

### `GET /integrations/orders?external_id=LD-1001,LD-1002`

Mostra l'estat actual de les comandes: estat, data prevista i data d'entrega, preu definitiu, fora de temps, caixes i quilos. Admet fins a 500 identificadors, separats per comes o amb el paràmetre repetit.

```json
{ "orders": [
  { "external_id": "LD-1001", "found": true, "order_id": 25330, "status": "processed",
    "route": { "id": 12, "name": "DC - BCN CIUTAT" }, "estimated_delivery_date": "2026-11-04", "delivery_date": null, "price": 9.24, "late_order": false,
    "late_surcharge": 0, "transfer": true, "units": 2, "kilograms": 10.5, "provider_order_number": "0560605" },
  { "external_id": "LD-1002", "found": false }
] }
```

Estats possibles: `pending` (pendent), `processed`, `deposited`, `distributing`, `lastmile`, `delivered` (lliurada), `invoiced` (facturada) i `cancelled` (anul·lada).

### `GET /integrations/catalog`

Torna el que podeu fer servir als altres camps:
- les rutes actives, amb els dies que surten;
- els magatzems, marcant el vostre per defecte;
- els sectors i les formes jurídiques;
- els vostres punts d'entrega, amb l'`external_id` que tenen enllaçat.

## Codis de rebuig

| `code` | Què vol dir |
|---|---|
| `INVALID` | Un camp falta o té un format incorrecte (`field`, `fields`) |
| `DUPLICATE_IN_REQUEST` | El mateix `external_id` surt dues vegades a la petició: només es processa el primer |
| `ROUTE_NOT_FOUND`, `ROUTE_AMBIGUOUS` | La ruta no existeix, no està activa o el nom en coincideix amb més d'una |
| `PICKUP_REQUIRED`, `PICKUP_NOT_FOUND` | Falta el magatzem o no existeix |
| `FARM_PICKUP_NOT_SUPPORTED` | Recollida a finca |
| `DELIVERY_POINT_NOT_FOUND`, `DELIVERY_POINT_AMBIGUOUS` | No es troba el punt d'entrega, o n'hi ha més d'un amb el mateix NIF i nom |
| `DELIVERY_POINT_INCOMPLETE` | Al punt d'entrega li falten dades. Completeu-lo abans amb `PUT /integrations/contacts` |
| `DATE_NOT_ALLOWED` | La data és d'avui o d'abans |
| `TOWN_WITHOUT_ROUTES` | La població del punt d'entrega no té cap ruta. Cal parlar amb l'oficina |
| `NO_ROUTE_DAY` | Cap ruta de la població surt en els 60 dies següents al dia demanat |
| `DATE_NOT_ON_ROUTE` | Només si envieu `route`: la ruta no surt aquell dia o està tancada. Porta `next_route_day`, el pròxim dia obert |
| `ROUTE_WITHOUT_DAYS` | Només si envieu `route`: la ruta no té cap dia obert |
| `ORDER_LOCKED` | La comanda ja no està pendent |
| `ORDER_CANCELLED` | La comanda està anul·lada |
| `INCOMPLETE` | Al punt d'entrega nou li falten dades obligatòries (`fields`) |
| `AMBIGUOUS_MATCH`, `ALREADY_LINKED` | No es pot enllaçar el punt: n'hi ha més d'un d'igual, o ja té un altre `external_id` |
| `FORBIDDEN` | La comanda o el punt ja no són vostres, o la norma no ho permet |
| `BUSY` | Una altra petició està desant el mateix `external_id`. Torneu-ho a provar |
| `ERROR` | Error intern. Torneu-ho a provar més tard o aviseu l'oficina |

## Avisos (`warnings`)

L'element s'ha desat, però val la pena revisar-lo:

| `code` | Què vol dir |
|---|---|
| `DATE_MOVED` | Cap ruta de la població surt el dia demanat: la comanda va el primer dia següent que en surt una |
| `LATE_ORDER` | Fora de l'hora límit: la comanda porta recàrrec |
| `PRICE_ESTIMATE` | `dry_run`: el preu és una estimació |
| `SECTOR_NOT_FOUND`, `LEGAL_FORM_NOT_FOUND` | El sector o la forma jurídica no existeixen: el punt es desa sense |
| `TOWN_WITHOUT_ROUTES` | La població del punt no té cap ruta: no s'hi podran fer comandes fins que l'oficina n'hi posi una |

## Exemple amb curl

```bash
curl -X PUT https://ladili.esstrapis.org/api/integrations/orders \
  -H "x-api-key: $DILIGENCIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true, "orders": [{"external_id": "LD-1001", "estimated_delivery_date": "2026-11-03",
       "delivery_point": {"external_id": "CLI-0042"}, "units": 2, "kilograms": 10.5, "pickup": "Artés"}]}'
```
