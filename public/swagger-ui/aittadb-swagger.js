window.addEventListener("DOMContentLoaded", () => {
  window.SwaggerUIBundle({
    url: "/openapi.json?format=json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: false,
    tryItOutEnabled: true,
    supportedSubmitMethods: ["get", "post", "put", "delete"],
    docExpansion: "list",
    defaultModelsExpandDepth: 1,
  });
});
