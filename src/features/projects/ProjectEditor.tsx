import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { Project } from "./model";
import { createProject, deleteProject, updateProject } from "./store";

/** New project, or edit one's name, description and the knowledge/instructions its tasks carry. */
export function ProjectEditor({ project, onClose }: { project?: Project; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    const fields = { name: name.trim() || "New project", description, instructions };
    if (project) updateProject(project.id, fields);
    else createProject(fields);
    onClose();
  };

  return (
    <Dialog title={project ? "Edit project" : "New project"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field">
          <label htmlFor="pj-name">Name</label>
          <input id="pj-name" className="input" autoFocus maxLength={120} value={name} placeholder="Website relaunch" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pj-desc">Description</label>
          <textarea id="pj-desc" className="textarea" style={{ minHeight: 70 }} value={description} placeholder="What this project is about" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pj-instr">Knowledge &amp; instructions</label>
          <textarea
            id="pj-instr"
            className="textarea"
            value={instructions}
            placeholder="Background, conventions, links, tone… Given to the bot with every task it runs."
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>
        <div className="btn-row" style={{ justifyContent: "space-between" }}>
          <div className="btn-row">
            {project &&
              (confirmDelete ? (
                <>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => {
                      deleteProject(project.id);
                      onClose();
                    }}
                  >
                    Delete project and its cards
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </button>
              ))}
          </div>
          <div className="btn-row dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {project ? "Save" : "Create project"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
