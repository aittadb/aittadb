window.addEventListener("DOMContentLoaded", () => {
  const deploymentOrigin = window.location.origin;
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
    requestInterceptor(request) {
      const target = new URL(request.url, deploymentOrigin);
      if (target.origin !== deploymentOrigin) {
        request.url = `${deploymentOrigin}${target.pathname}${target.search}${target.hash}`;
      }
      request.headers = request.headers || {};
      if (
        String(request.method || "GET").toUpperCase() === "GET" &&
        (!request.headers.Accept || request.headers.Accept === "*/*") &&
        (!request.headers.accept || request.headers.accept === "*/*")
      ) {
        request.headers.Accept = "application/json";
      }
      request.credentials = "same-origin";
      return request;
    },
  });
});
