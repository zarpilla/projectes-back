module.exports = {
  rest: {
    defaultLimit: 25,
    // v3 used _limit:-1 (return-all) pervasively. The Phase 3 query-param adapter
    // translates that to a large pageSize; raise maxLimit so those calls don't get
    // silently capped during the migration. Tighten once all call sites are audited.
    maxLimit: 100000,
    withCount: true,
    strictParams: true,
  },
  documents: {
    strictParams: true,
    strictRelations: true,
  },
};
