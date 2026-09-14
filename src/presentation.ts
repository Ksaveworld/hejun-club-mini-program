// Only the explicitly named presentation build runs without the local API.
export const isPresentation = import.meta.env.MODE === 'presentation';
