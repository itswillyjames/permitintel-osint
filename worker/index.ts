export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/analyze" && request.method === "POST") {
      try {
        const body = await request.json();
        const permit = body.permit || body;

        const normalized = {
          id: `PERMIT-${Date.now()}`,
          address: permit.address || "Unknown",
          city: permit.city || "Unknown",
          description: permit.description || "",
          estimatedCost: permit.estimatedCost || 0,
          applicant: permit.applicant || "Unknown",
        };

        // Simple opportunity logic (fast-deal optimized)
        const opportunities = [
          {
            vertical: "general contractor",
            angle: "Project may still be open for bidding",
            urgency: "high",
          },
          {
            vertical: "material supplier",
            angle: "Supply materials for project",
            urgency: "medium",
          },
          {
            vertical: "lender",
            angle: "Financing opportunity",
            urgency: "medium",
          },
        ];

        const response = {
          assetType: "rapid-kit",
          manifest: normalized,
          topOpportunities: opportunities,
          outreachKit: {
            subject: "New project opportunity nearby",
            body: `A project at ${normalized.address} may require your services. Want details?`,
          },
        };

        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
