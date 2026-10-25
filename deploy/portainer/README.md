# Portainer app template

`portainer-template.json` is a single Portainer app template (format version 3, type 3 = stack).
[Lissy93/portainer-templates](https://github.com/Lissy93/portainer-templates) pulls it nightly from
`main` via its `sources.csv`, so a change here reaches that catalog without a PR there.

The template does not carry its own Compose file. It points Portainer at
`docs/docker-compose.portainer.yml`, the same descriptor as the documented Git/GitOps stack, so a new
variable or volume only has to land there. The `env` list here only names the fields the form shows:
the two required secrets, the host port and `BASE_URL`. Everything else keeps the Compose default.

Rules, held by `npm run test:installer-schema`:

- every `env` name must be a `${...}` variable of the stack file;
- the variables the stack file requires (`${VAR:?...}`) must be in the form, without a default;
- a variable that locks a field in the settings UI must not get a non-empty `default` here.
