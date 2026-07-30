// Azure DevOps Server (TFS) REST client.
// The on-prem OneMinute used the .NET SDK; here we call the REST API directly
// with a PAT (Basic auth) so it works from Node/serverless.
//
// Env:
//   DEVOPS_API_URL     e.g. https://tfs.3tt.com.au/tfs/3ttProjects/
//   DEVOPS_PAT         a Personal Access Token (Work Items R/W, Project read)
//   DEVOPS_USER        the PAT account's username, e.g. "biraj". On-prem TFS
//                      requires "username:PAT" Basic auth; Azure DevOps Services
//                      accepts an empty username, so leave this blank there.
//   DEVOPS_API_VERSION optional, defaults to 5.0 (proven against on-prem TFS)

const API_URL = process.env.DEVOPS_API_URL ?? "";
const PAT = process.env.DEVOPS_PAT ?? "";
const USER = process.env.DEVOPS_USER ?? "";
const API_VERSION = process.env.DEVOPS_API_VERSION ?? "5.0";

export function devopsConfigured(): boolean {
  return !!API_URL && !!PAT;
}

function authHeader(): string {
  // Basic auth: base64("username:PAT"). On-prem TFS requires the username
  // (e.g. "biraj" via DEVOPS_USER); Azure DevOps Services accepts an empty one.
  const token = Buffer.from(`${USER}:${PAT}`).toString("base64");
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

export interface WorkItemComment {
  text: string;
  author: string | null;
  date: string | null;
}

export interface WorkItemDetail {
  id: number;
  title: string | null;
  type: string | null;
  state: string | null;
  assignedTo: string | null;
  project: string | null;
  createdDate: string | null;
  changedDate: string | null;
  comments: WorkItemComment[];
}

/** Full work-item detail for the in-app popup: fields + comments (best-effort). */
export async function getWorkItemDetail(id: number): Promise<WorkItemDetail> {
  if (!devopsConfigured()) throw new Error("DevOps is not configured");

  const url = `${base()}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`DevOps getWorkItem ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { id: number; fields?: Record<string, unknown> };
  const f = data.fields ?? {};

  const person = (v: unknown): string | null =>
    v && typeof v === "object" && "displayName" in v
      ? String((v as { displayName: unknown }).displayName)
      : v
        ? String(v)
        : null;

  return {
    id: data.id,
    title: (f["System.Title"] as string) ?? null,
    type: (f["System.WorkItemType"] as string) ?? null,
    state: (f["System.State"] as string) ?? null,
    assignedTo: person(f["System.AssignedTo"]),
    project: (f["System.TeamProject"] as string) ?? null,
    createdDate: (f["System.CreatedDate"] as string) ?? null,
    changedDate: (f["System.ChangedDate"] as string) ?? null,
    comments: await getWorkItemComments(id)
  };
}

// Comments are a preview API and may not exist on older TFS — best-effort, so a
// failure returns [] rather than breaking the whole detail view.
async function getWorkItemComments(id: number): Promise<WorkItemComment[]> {
  try {
    const url = `${base()}/_apis/wit/workItems/${id}/comments?api-version=${API_VERSION}-preview.3`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      comments?: Array<{ text?: string; createdBy?: { displayName?: string }; createdDate?: string }>;
    };
    return (data.comments ?? []).map((c) => ({
      text: stripHtml(c.text ?? ""),
      author: c.createdBy?.displayName ?? null,
      date: c.createdDate ?? null
    }));
  } catch {
    return [];
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export interface DevopsRequest {
  action: "create" | "link";
  workItemId?: string; // for link
  project?: string; // for create
  workItemType?: "User Story" | "Bug"; // for create
  title: string;
  description?: string | null;
  assignedTo?: string | null;
  state?: string | null;
}

/** Create a new work item or verify an existing one to link. Returns id + project. */
export async function createOrLinkWorkItem(
  req: DevopsRequest
): Promise<{ id: number; project: string | null }> {
  if (!devopsConfigured()) throw new Error("DevOps not configured");

  if (req.action === "link") {
    const id = parseInt(req.workItemId ?? "", 10);
    if (isNaN(id)) throw new Error("invalid work item id");
    const wi = await getWorkItem(id); // verifies it exists
    return { id: wi.id, project: wi.project };
  }

  const project = (req.project ?? "").trim();
  if (!project) throw new Error("no DevOps project specified");
  const id = await createWorkItem({
    project,
    type: req.workItemType ?? "User Story",
    title: req.title.trim(),
    description: req.description ?? null,
    assignedTo: req.assignedTo ?? null,
    state: req.state ?? null
  });
  return { id, project };
}
