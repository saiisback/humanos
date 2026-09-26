# @humanos/contracts

`HumanOSRegistrar` composes the official ENSv2 contracts (`ensdomains/contracts-v2` pinned at
`71a3b7339dbc55ab47667abdfe8303bac4f4c24e`, the commit the ENS docs render their Sepolia deployment
table from) into HumanOS identities:

```
<parent>.eth                         official ETHRegistry, owned by the operator
└─ HumanOS UserRegistry              VerifiableFactory proxy deployed by the registrar
   └─ <root>.<parent>.eth            one per verified human, own PermissionedResolver
      └─ root UserRegistry
         └─ <task>.<root>.<parent>.eth   task agent, own PermissionedResolver
```

- Agents hold no registry roles: they cannot transfer, re-point resolvers or subregistries, or renew.
- Each agent has argument-scoped `setText` grants for `humanos.status` and `humanos.receipt` only,
  on a dedicated resolver (resolver grants are resolver-wide per key, so sharing would leak).
- Registration also initializes the standard ENS `description` record for public About panels.
  Draft-only agents receive a draft-specific description; other agents receive a scope-neutral
  description directing readers to live permissions. No private task content is published, and
  agents receive no permission to change this description. The profile is not proof of truthful output.
- Expiry is bounded down the hierarchy (agent ≤ root ≤ parent). Expired or revoked labels never
  come back. `authorization(node)` is active only while the whole official chain still resolves.
- Nobody holds upgrade, resolver, subregistry, link or admin roles on the deployed proxies.

## Commands

```sh
pnpm deps                 # fetch pinned contracts-v2 + submodules into lib/ (gitignored)
pnpm test                 # forge test -vvv
pnpm abi                  # regenerate packages/ens/src/abi/humanosRegistrar.ts
```

## Sepolia deployment

Prerequisite: the deployer owns `<HUMANOS_PARENT_LABEL>.eth` in the official ENSv2 ETHRegistry
(register it through the official ETH Registrar, e.g. app.ens.dev on Sepolia).

```sh
export SEPOLIA_RPC_URL=... DEPLOYER_PRIVATE_KEY=... HUMANOS_PARENT_LABEL=...
# optional: HUMANOS_REGISTRAR_OWNER (defaults to the deployer)
pnpm deploy:sepolia:dry   # simulation only; refuses without env, chain, official code, parent ownership
pnpm deploy:sepolia       # broadcasts and verifies source on Sourcify
pnpm record:sepolia       # checks receipts on-chain, writes deployments/humanos-sepolia.json
```

`deployments/ensv2-sepolia.json` records the official addresses and how they were verified.
