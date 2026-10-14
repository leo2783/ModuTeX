# Frontend contracts

Types and runtime validators for the ModuTeX frontend/desktop boundary.
Validators accept unknown input and reject malformed records, unsafe relative
paths, invalid identities, and inconsistent read, write, save-as, or compile
receipts. Recent-document validation keeps native paths outside public IDs.

Validation does not grant filesystem access. The desktop implementation must
still enforce workspace containment and operation ownership.

## Development

Run from the repository root with Node.js 24.19.0 and npm 11.17.0:

```sh
npm run build --workspace=@modutex/frontend-contracts
npm run check --workspace=@modutex/frontend-contracts
npm run test --workspace=@modutex/frontend-contracts
```

Tests exercise accepted and rejected payloads, accessor/extra-field rejection,
path validation, compile identity/result matching, and recent-document limits.

## License

Private workspace package. Its license remains `UNLICENSED` pending provenance
review; this is not a declaration that the desktop application is Apache-2.0.
