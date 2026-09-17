import type {IArtifactStore} from '@_linked/core/interfaces/IArtifactStore';

export const assertArtifactStore = (value: unknown): IArtifactStore => {
  const candidate = value as Partial<IArtifactStore> | null;
  if (
    !candidate ||
    typeof candidate.describeDestination !== 'function' ||
    typeof candidate.putArtifact !== 'function' ||
    typeof candidate.statArtifact !== 'function'
  ) {
    throw new Error(
      'The configured static store does not support verified artifact publishing',
    );
  }
  return candidate as IArtifactStore;
};

