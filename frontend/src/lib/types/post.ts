export interface PostMetadata {
  title: string;
  image?: string;
  published: string;
  pinned: boolean;
  description: string;
  draft?: boolean;
  hide?: boolean;
  updated?: string;
}

export interface Post {
  slug: string;
  metadata: PostMetadata;
  content: string;
}
