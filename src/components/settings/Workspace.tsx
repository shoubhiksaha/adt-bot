import { Wand2 } from "lucide-react";
import { useState } from "react";
import { fileText } from "../../lib/images";
import { updateSettings, useStore } from "../../lib/store";
import { KNOWLEDGE_ACCEPT, KnowledgeFiles } from "../KnowledgeFiles";
import { Section } from "./controls";

/** Who you are, what your organisation does, what the bots are for, plus shared knowledge files. */
export function WorkspaceSettings() {
  const settings = useStore((s) => s.settings);
  const [notice, setNotice] = useState<string | null>(null);

  const fillAboutFromFile = async (file: File) => {
    try {
      const text = (await fileText(file)).trim();
      const about = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      updateSettings({ about: settings.about ? `${settings.about}\n\n${about}` : about });
      setNotice(
        text.length > 4000
          ? `Added the start of ${file.name}. The full file is better as a knowledge file below.`
          : `Added ${file.name}.`,
      );
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  return (
    <div>
      <Section title="You">
        <div className="field">
          <label htmlFor="user-name">What should the bots call you?</label>
          <input
            id="user-name"
            className="input"
            placeholder="e.g. Sam"
            defaultValue={settings.userName}
            onBlur={(e) => updateSettings({ userName: e.target.value.trim() })}
          />
        </div>
      </Section>

      <Section
        title="About you, your team or company"
        hint="Who you are, what you do, who your customers are, and what the bots are expected to do. Every bot reads this."
      >
        <div className="field">
          <textarea
            id="about"
            key={settings.about.length}
            className="textarea"
            style={{ minHeight: 140 }}
            placeholder={
              "e.g. We're Acme Dental, a 12-person clinic in Pune. Bots help our front desk answer patient questions, " +
              "draft WhatsApp replies in a friendly, professional tone, and summarise insurance documents. Never give medical diagnoses."
            }
            defaultValue={settings.about}
            onBlur={(e) => updateSettings({ about: e.target.value })}
          />
          <label className="link-btn" style={{ marginBottom: 0 }}>
            <Wand2 size={14} /> Fill from a file (company profile, About page…)
            <input
              type="file"
              hidden
              accept={KNOWLEDGE_ACCEPT}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void fillAboutFromFile(file);
                e.target.value = "";
              }}
            />
          </label>
          {notice && <span className="small muted">{notice}</span>}
        </div>
      </Section>

      <Section title="How bots should answer" hint="Style rules for every bot, e.g. tone, length, units, language.">
        <div className="field">
          <textarea
            id="custom-instructions"
            className="textarea"
            style={{ minHeight: 90 }}
            placeholder="e.g. Keep answers short. Use metric units and Indian English. Cite sources for facts."
            defaultValue={settings.customInstructions}
            onBlur={(e) => updateSettings({ customInstructions: e.target.value })}
          />
        </div>
      </Section>

      <Section
        title="Shared knowledge"
        hint="Documents every bot can use to answer: company profile, handbook, price list, FAQs, product docs. Bots can also have their own files (bot settings)."
      >
        <KnowledgeFiles
          refs={settings.knowledge}
          onChange={(knowledge) => updateSettings({ knowledge })}
          hint="Drop documents here."
        />
      </Section>
    </div>
  );
}
