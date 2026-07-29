// Azure DevOps Server (TFS) REST client.
// The on-prem OneMinute used the .NET SDK; here we call the REST API directly
// with a PAT (Basic auth) so it works from Node/serverless.
//
// Env:
//   DEVOPS_API_URL     e.g. https://tfs.3tt.com.au/tfs/3ttProjects/
//   DEVOPS_PAT         a Personal Access Token (Work Items R/W, Project read)
//   DEVOPS_API_VERSION optional, defaults to 6.0

const API_URL = process.env.DEVOPS_API_URL ?? "";
const PAT = process.env.DEVOPS_PAT ?? "";
const API_VERSION = process.env.DEVOPS_API_VERSION ?? "6.0";

export function devopsConfigured(): boolean {
  return !!API_URL && !!PAT;
}

function authHeader(): string {
  // Basic auth with an empty username and the PAT as password.
  const token = Buffer.from(`:${PAT}`).toString("base64");
  return `Basic ${token}`;
}

function base(): string {
  return API_URL.replace(/\/+$/, "");
}

/** Direct browser URL for a work item (for display / linking out). */
export function workItemUrl(id: number): string {
  return `${base()}/_workitems/edit/${id}`;
}

export interface DevopsProject {
  id: string;
  name: string;
}

export async function listProjects(): Promise<DevopsProject[]> {
  if (!devopsConfigured()) throw new Error("DevOps is not configured");

  const url = `${base()}/_apis/projects?api-version=${API_VERSION}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    throw new Error(`DevOps listProjects ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { value?: Array<{ id: string; name: string }> };
  return (data.value ?? [])
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface WorkItem {
  id: number;
  title: string | null;
  state: string | null;
  assignedTo: string | null;
  project: string | null;
}

function parseWorkItem(data: {
  id: number;
  fields?: Record<string, unknown>;
}): WorkItem {
  const f = data.fields ?? {};
  const assigned = f["System.AssignedTo"];
  const assignedName =
    assigned && typeof assigned === "object" && "displayName" in assigned
      ? String((assigned as { displayName: unknown }).displayName)
      : assigned
        ? String(assigned)
        : null;
  return {
    id: data.id,
    title: (f["System.Title"] as string) ?? null,
    state: (f["System.State"] as string) ?? null,
    assignedTo: assignedName,
    project: (f["System.TeamProject"] as string) ?? null
  };
}

/** Fetch a work item to verify it exists (used when LINKING). */
export async function getWorkItem(id: number): Promise<WorkItem> {
  if (!devopsConfigured()) throw new Error("DevOps is not configured");

  const url = `${base()}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    throw new Error(`DevOps getWorkItem ${res.status}: ${await res.text()}`);
  }
  return parseWorkItem(await res.json());
}

export interface CreateWorkItemInput {
  project: string;
  type: "User Story" | "Bug";
  title: string;
  description?: string | null;
  assignedTo?: string | null;
  state?: string | null;
}

/** Create a new work item; returns its id. */
export async function createWorkItem(input: CreateWorkItemInput): Promise<number> {
  if (!devopsConfigured()) throw new Error("DevOps is not configured");

  const ops: Array<{ op: string; path: string; value: string }> = [
    { op: "add", path: "/fields/System.Title", value: input.title }
  ];

  if (input.description) {
    // Bugs put the detail in Repro Steps; stories use Description.
    const path =
      input.type === "Bug"
        ? "/fields/Microsoft.VSTS.TCM.ReproSteps"
        : "/fields/System.Description";
    ops.push({ op: "add", path, value: input.description });
  }
  if (input.assignedTo) {
    ops.push({ op: "add", path: "/fields/System.AssignedTo", value: input.assignedTo });
  }
  if (input.state) {
    ops.push({ op: "add", path: "/fields/System.State", value: input.state });
  }

  const type = encodeURIComponent(input.type);
  const url = `${base()}/${encodeURIComponent(input.project)}/_apis/wit/workitems/$${type}?api-version=${API_VERSION}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json-patch+json"
    },
    body: JSON.stringify(ops)
  });

  if (!res.ok) {
    throw new Error(`DevOps createWorkItem ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}
