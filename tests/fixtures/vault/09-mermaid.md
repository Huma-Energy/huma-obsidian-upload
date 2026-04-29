# Mermaid diagram

```mermaid
flowchart LR
    Plugin --> |push| Server
    Server --> |pull| Plugin
    Plugin --> |conflict.md| Vault
```
