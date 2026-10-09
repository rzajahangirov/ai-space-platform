// Deployment manifest for the ShopSphere demo. It intentionally differs from the designed graph:
// the product service has no cache connection, the order service talks to Redis, and a
// notification worker exists that the architecture never mentions.
export const shopSphereCompose = `services:
  storefront:
    build: ./apps/storefront
    ports: ["3000:3000"]
    environment:
      API_URL: http://gateway:8080
    depends_on: [gateway]
  gateway:
    image: nginx:1.27
    ports: ["8080:80"]
    depends_on: [product-service, order-service, identity]
  identity:
    image: quay.io/keycloak/keycloak:26.0
  product-service:
    build: ./services/products
    environment:
      DATABASE_URL: postgres://products@postgres:5432/shop
    depends_on: [postgres]
  order-service:
    build: ./services/orders
    environment:
      DATABASE_URL: postgres://orders@postgres:5432/shop
      KAFKA_BROKERS: kafka:9092
      CACHE_URL: redis://redis:6379
  payment-service:
    build: ./services/payments
    environment:
      DATABASE_URL: postgres://payments@postgres:5432/shop
      KAFKA_BROKERS: kafka:9092
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY}
  notification-worker:
    build: ./services/notifications
    environment:
      KAFKA_BROKERS: kafka:9092
  postgres:
    image: postgres:17
  redis:
    image: redis:7.4
  kafka:
    image: apache/kafka:3.9.0
  minio:
    image: minio/minio:latest
  grafana:
    image: grafana/grafana:11.4.0
`;
