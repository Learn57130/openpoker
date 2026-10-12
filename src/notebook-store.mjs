import { randomUUID } from 'node:crypto';
import { createPrivateJsonFile } from './lib/files.mjs';
import { LESSON_LIMITS, parseLessons, promptLessons } from './lessons.mjs';

export const NOTEBOOK_SCHEMA = 'jev/poker-notebook/v1';

function storeError(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code });
}

/**
 * The table's one notebook, shared by every AI player: measured facts after each game and the
 * lessons AI players wrote about their own play, newest first. Lesson text is untrusted model
 * output, kept and returned as plain strings only.
 */
export function createNotebookStore({ file, now = () => new Date() }) {
  const store = createPrivateJsonFile({ file, schema: NOTEBOOK_SCHEMA, invalidCode: 'NOTEBOOK_INVALID', empty: () => ({ learning: true, lessons: [], facts: [] }) });

  return {
    async read() {
      const { learning, lessons, facts } = await store.read();
      return { learning, lessons: lessons.map(lesson => ({ ...lesson })), facts: facts.map(entry => structuredClone(entry)) };
    },

    /** The lessons to quote in a move's prompt, or none while learning is off. */
    async promptLessons() {
      const { learning, lessons } = await store.read();
      return learning ? promptLessons(lessons.map(lesson => lesson.text)) : [];
    },

    async setLearning(on) {
      if (typeof on !== 'boolean') throw storeError('learning must be true or false');
      return await store.change(data => {
        data.learning = on;
        return { learning: on };
      });
    },

    /** `entries` are `{ game, player, name, hands, rating_before, rating_after, bb_per_100, facts }`. */
    async addFacts(entries) {
      return await store.change(data => {
        const at = now().toISOString();
        data.facts.unshift(...entries.map(entry => ({ at, ...entry })));
        data.facts.length = Math.min(data.facts.length, LESSON_LIMITS.facts);
        return entries.length;
      });
    },

    /** Cleans a review reply into lessons and keeps the new ones. Returns the lessons added. */
    async addLessons(reply, { by, game }) {
      return await store.change(data => {
        const at = now().toISOString();
        const added = parseLessons(reply, data.lessons.map(lesson => lesson.text)).map(text => ({ id: randomUUID().slice(0, 8), at, game, by, text }));
        data.lessons.unshift(...added);
        data.lessons.length = Math.min(data.lessons.length, LESSON_LIMITS.kept);
        return added;
      });
    },

    async removeLesson(id) {
      return await store.change(data => {
        const index = data.lessons.findIndex(lesson => lesson.id === id);
        if (index < 0) throw storeError('No lesson has that id', 'LESSON_NOT_FOUND');
        data.lessons.splice(index, 1);
        return { removed: true };
      });
    },

    /** Empties the notebook. The learning switch stays as it is. */
    async clear() {
      return await store.change(data => {
        data.lessons = [];
        data.facts = [];
        return { cleared: true };
      });
    }
  };
}
