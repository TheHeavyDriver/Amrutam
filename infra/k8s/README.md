# Kubernetes deployment

The base manifests deploy three stateless components:

- `amrutam-api` Deployment + Service + Ingress (ingress-nginx, cert-manager).
- `amrutam-worker` Deployment + metrics Service for outbox and scheduled jobs.
- `amrutam-migrate` Job template, applied separately for migration gating before the overlay rollout.

The rendered pods run as UID 1000, non-root, with a read-only root filesystem, all capabilities dropped, and `RuntimeDefault` seccomp. The base namespace enforces the restricted Pod Security Standard.

## Prerequisites

1. An EKS/GKE cluster with ingress-nginx, cert-manager, metrics-server, and a monitoring namespace.
2. `amrutam-secrets` created from [base/secret.example.yaml](base/secret.example.yaml) via External Secrets/Sealed Secrets (never commit real values).
3. Network reachability from the cluster to RDS and ElastiCache on 5432/6379, and to the OTLP collector on 4318.
4. The Terraform stack applied (`infra/terraform`); output `app_security_group_id` should be attached to node groups or allowed explicitly.

## Deploy

```bash
IMAGE=ghcr.io/your-org/amrutam-api:${GIT_SHA}
sed -i "s|ghcr.io/example/amrutam-api:latest|${IMAGE}|g" \
  infra/k8s/base/api-deployment.yaml \
  infra/k8s/base/worker-deployment.yaml \
  infra/k8s/jobs/migrate.yaml

kubectl apply -f infra/k8s/base/namespace.yaml
kubectl apply -f infra/k8s/base/configmap.yaml
kubectl get secret amrutam-secrets -n amrutam
kubectl delete job amrutam-migrate -n amrutam --ignore-not-found
kubectl apply -f infra/k8s/jobs/migrate.yaml
kubectl wait --for=condition=complete --timeout=300s job/amrutam-migrate -n amrutam

kubectl apply -k infra/k8s/overlays/staging
kubectl rollout status deploy/amrutam-api -n amrutam --timeout=5m
kubectl rollout status deploy/amrutam-worker -n amrutam --timeout=5m
```

Run the CI-deployed equivalent from `.github/workflows/cd-staging.yml`. Migration must complete before the API rollout; the CD workflow enforces this.

## Notes

- The HPA scales the API to 30 and the worker to 8. Keep total database connections within the RDS/proxy budget; use PgBouncer for sustained scale.
- The migration Job is immutable by name in staging; the CD workflow deletes the previous completed job before applying.
- Database rollback is a deliberate operational decision, not automatic with `kubectl rollout undo`. See `docs/runbooks.md`.
- NetworkPolicy controls ingress inside the cluster. Restrict egress with cloud security groups/firewall to RDS, Redis, OTLP, and DNS.
